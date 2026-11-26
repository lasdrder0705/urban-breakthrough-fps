(() => {
  'use strict';

  const DF = (window.DF = window.DF || {});

  // Standard interleaved vertex layout: 15 floats = 60 bytes
  // loc 0: pos (3f)     offset 0
  // loc 1: normal (3f)  offset 12
  // loc 2: uv (2f)      offset 24
  // loc 3: tangent (4f) offset 32 (tx, ty, tz, handedness)
  // loc 4: color (3f)   offset 48 (vertex tint / baked AO)
  const VERTEX_FLOATS = 15;
  const VERTEX_STRIDE = VERTEX_FLOATS * 4;

  // Build 3x3 rotation matrix from Euler YXZ (Ry * Rx * Rz)
  function buildRot3(rx, ry, rz) {
    const cx = Math.cos(rx || 0), sx = Math.sin(rx || 0);
    const cy = Math.cos(ry || 0), sy = Math.sin(ry || 0);
    const cz = Math.cos(rz || 0), sz = Math.sin(rz || 0);
    return [
      cy * cz + sy * sx * sz, cx * sz, -sy * cz + cy * sx * sz,
      -cy * sz + sy * sx * cz, cx * cz, sy * sz + cy * sx * cz,
      sy * cx, -sx, cy * cx,
    ];
  }

  function applyRot(r, x, y, z) {
    return [
      r[0] * x + r[3] * y + r[6] * z,
      r[1] * x + r[4] * y + r[7] * z,
      r[2] * x + r[5] * y + r[8] * z,
    ];
  }

  function normalize3(x, y, z) {
    const l = Math.hypot(x, y, z);
    if (l < 1e-8) return [0, 1, 0];
    return [x / l, y / l, z / l];
  }

  function parseUVScale(uvScale) {
    if (uvScale === undefined || uvScale === null) return [1, 1];
    if (typeof uvScale === 'number') return [uvScale, uvScale];
    return [uvScale[0] !== undefined ? uvScale[0] : 1, uvScale[1] !== undefined ? uvScale[1] : 1];
  }

  function parseColor(color) {
    if (!color) return [1, 1, 1];
    if (typeof color === 'number') return [color, color, color];
    return [color[0], color[1], color[2]];
  }

  function parseFaceMask(faces) {
    const all = { top: true, bottom: true, front: true, back: true, right: true, left: true };
    if (!faces) return all;
    const alias = {
      top: 'top', py: 'top', '+y': 'top',
      bottom: 'bottom', ny: 'bottom', '-y': 'bottom',
      front: 'front', pz: 'front', '+z': 'front',
      back: 'back', nz: 'back', '-z': 'back',
      right: 'right', px: 'right', '+x': 'right',
      left: 'left', nx: 'left', '-x': 'left',
    };
    if (Array.isArray(faces)) {
      const mask = { top: false, bottom: false, front: false, back: false, right: false, left: false };
      for (let i = 0; i < faces.length; i++) {
        const k = alias[String(faces[i]).toLowerCase()];
        if (k) mask[k] = true;
      }
      return mask;
    }
    let hasFalse = false;
    let hasTrue = false;
    for (const key in faces) {
      if (faces[key] === false) hasFalse = true;
      if (faces[key] === true) hasTrue = true;
    }
    const defaultVal = hasFalse || !hasTrue;
    const mask = {
      top: defaultVal, bottom: defaultVal, front: defaultVal,
      back: defaultVal, right: defaultVal, left: defaultVal,
    };
    for (const key in faces) {
      const k = alias[key.toLowerCase()];
      if (k) mask[k] = !!faces[key];
    }
    return mask;
  }

  // ---------------------------------------------------------------------------
  // Builder Class (works with or without `new`)
  // ---------------------------------------------------------------------------
  function Builder() {
    if (!(this instanceof Builder)) return new Builder();
    this.verts = [];
    this.indices = [];
    this._tangentsComputed = false;
  }

  Builder.prototype.clear = function () {
    this.verts.length = 0;
    this.indices.length = 0;
    this._tangentsComputed = false;
    return this;
  };

  Builder.prototype._pushVert = function (px, py, pz, nx, ny, nz, u, v, cr, cg, cb) {
    const idx = this.verts.length / VERTEX_FLOATS;
    this.verts.push(
      px, py, pz,
      nx, ny, nz,
      u, v,
      1, 0, 0, 1,
      cr, cg, cb
    );
    this._tangentsComputed = false;
    return idx;
  };

  Builder.prototype._pushTriOriented = function (p0, p1, p2, nExpected, uv0, uv1, uv2, col0, col1, col2) {
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const n = nExpected || normalize3(cx, cy, cz);
    const dot = cx * n[0] + cy * n[1] + cz * n[2];

    const i0 = this._pushVert(p0[0], p0[1], p0[2], n[0], n[1], n[2], uv0[0], uv0[1], col0[0], col0[1], col0[2]);
    const i1 = this._pushVert(p1[0], p1[1], p1[2], n[0], n[1], n[2], uv1[0], uv1[1], col1[0], col1[1], col1[2]);
    const i2 = this._pushVert(p2[0], p2[1], p2[2], n[0], n[1], n[2], uv2[0], uv2[1], col2[0], col2[1], col2[2]);
    if (dot >= 0) {
      this.indices.push(i0, i1, i2);
    } else {
      this.indices.push(i0, i2, i1);
    }
  };

  Builder.prototype._pushQuadOriented = function (p0, p1, p2, p3, nExpected, uv0, uv1, uv2, uv3, c0, c1, c2, c3) {
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const n = nExpected || normalize3(cx, cy, cz);
    const dot = cx * n[0] + cy * n[1] + cz * n[2];

    const i0 = this._pushVert(p0[0], p0[1], p0[2], n[0], n[1], n[2], uv0[0], uv0[1], c0[0], c0[1], c0[2]);
    const i1 = this._pushVert(p1[0], p1[1], p1[2], n[0], n[1], n[2], uv1[0], uv1[1], c1[0], c1[1], c1[2]);
    const i2 = this._pushVert(p2[0], p2[1], p2[2], n[0], n[1], n[2], uv2[0], uv2[1], c2[0], c2[1], c2[2]);
    const i3 = this._pushVert(p3[0], p3[1], p3[2], n[0], n[1], n[2], uv3[0], uv3[1], c3[0], c3[1], c3[2]);

    if (dot >= 0) {
      this.indices.push(i0, i1, i2, i0, i2, i3);
    } else {
      this.indices.push(i0, i3, i2, i0, i2, i1);
    }
  };

  // ---------------------------------------------------------------------------
  // addQuad(p0, p1, p2, p3, uv0, uv1, uv2, uv3, color)
  // ---------------------------------------------------------------------------
  Builder.prototype.addQuad = function (p0, p1, p2, p3, uv0, uv1, uv2, uv3, color) {
    const u0 = uv0 || [0, 0];
    const u1 = uv1 || [1, 0];
    const u2 = uv2 || [1, 1];
    const u3 = uv3 || [0, 1];
    const c = parseColor(color);

    let e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    let e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    if (nx * nx + ny * ny + nz * nz < 1e-10) {
      e1x = p2[0] - p0[0]; e1y = p2[1] - p0[1]; e1z = p2[2] - p0[2];
      e2x = p3[0] - p0[0]; e2y = p3[1] - p0[1]; e2z = p3[2] - p0[2];
      nx = e1y * e2z - e1z * e2y;
      ny = e1z * e2x - e1x * e2z;
      nz = e1x * e2y - e1y * e2x;
    }
    const n = normalize3(nx, ny, nz);

    const i0 = this._pushVert(p0[0], p0[1], p0[2], n[0], n[1], n[2], u0[0], u0[1], c[0], c[1], c[2]);
    const i1 = this._pushVert(p1[0], p1[1], p1[2], n[0], n[1], n[2], u1[0], u1[1], c[0], c[1], c[2]);
    const i2 = this._pushVert(p2[0], p2[1], p2[2], n[0], n[1], n[2], u2[0], u2[1], c[0], c[1], c[2]);
    const i3 = this._pushVert(p3[0], p3[1], p3[2], n[0], n[1], n[2], u3[0], u3[1], c[0], c[1], c[2]);
    this.indices.push(i0, i1, i2, i0, i2, i3);
    return this;
  };

  Builder.prototype.addTriangle = function (p0, p1, p2, uv0, uv1, uv2, color) {
    const u0 = uv0 || [0, 0];
    const u1 = uv1 || [1, 0];
    const u2 = uv2 || [0.5, 1];
    const c = parseColor(color);
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    const n = normalize3(
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x
    );
    const i0 = this._pushVert(p0[0], p0[1], p0[2], n[0], n[1], n[2], u0[0], u0[1], c[0], c[1], c[2]);
    const i1 = this._pushVert(p1[0], p1[1], p1[2], n[0], n[1], n[2], u1[0], u1[1], c[0], c[1], c[2]);
    const i2 = this._pushVert(p2[0], p2[1], p2[2], n[0], n[1], n[2], u2[0], u2[1], c[0], c[1], c[2]);
    this.indices.push(i0, i1, i2);
    return this;
  };

  // ---------------------------------------------------------------------------
  // addBox(cx, cy, cz, sx, sy, sz, opts)
  // ---------------------------------------------------------------------------
  Builder.prototype.addBox = function (cx, cy, cz, sx, sy, sz, opts) {
    const o = opts || {};
    if (o.bevel && o.bevel > 0) {
      return this.addBeveledBox(cx, cy, cz, sx, sy, sz, o.bevel, o);
    }

    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const [us, vs] = parseUVScale(o.uvScale);
    const unitUV = !!o.unitUV;
    const baseCol = parseColor(o.color);
    const aoBot = o.aoBottom !== undefined ? o.aoBottom : 1.0;
    const aoTop = o.aoTop !== undefined ? o.aoTop : 1.0;
    const colBot = [baseCol[0] * aoBot, baseCol[1] * aoBot, baseCol[2] * aoBot];
    const colTop = [baseCol[0] * aoTop, baseCol[1] * aoTop, baseCol[2] * aoTop];
    const mask = parseFaceMask(o.faces);
    const hasRot = !!(o.rotX || o.rotY || o.rotZ);
    const rot = hasRot ? buildRot3(o.rotX, o.rotY, o.rotZ) : null;

    const xformP = (x, y, z) => {
      if (!rot) return [cx + x, cy + y, cz + z];
      const r = applyRot(rot, x, y, z);
      return [cx + r[0], cy + r[1], cz + r[2]];
    };
    const xformN = (x, y, z) => (rot ? applyRot(rot, x, y, z) : [x, y, z]);

    const addFace = (key, pts, norm, w, h, cols) => {
      if (!mask[key]) return;
      const uw = (unitUV ? 1 : w) * us;
      const vh = (unitUV ? 1 : h) * vs;
      const n = xformN(norm[0], norm[1], norm[2]);
      this._pushQuadOriented(
        xformP(pts[0][0], pts[0][1], pts[0][2]),
        xformP(pts[1][0], pts[1][1], pts[1][2]),
        xformP(pts[2][0], pts[2][1], pts[2][2]),
        xformP(pts[3][0], pts[3][1], pts[3][2]),
        n,
        [0, 0], [uw, 0], [uw, vh], [0, vh],
        cols[0], cols[1], cols[2], cols[3]
      );
    };

    // +Z Front
    addFace('front', [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], [0, 0, 1], sx, sy, [colBot, colBot, colTop, colTop]);
    // -Z Back
    addFace('back', [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], [0, 0, -1], sx, sy, [colBot, colBot, colTop, colTop]);
    // +X Right
    addFace('right', [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], [1, 0, 0], sz, sy, [colBot, colBot, colTop, colTop]);
    // -X Left
    addFace('left', [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], [-1, 0, 0], sz, sy, [colBot, colBot, colTop, colTop]);
    // +Y Top
    addFace('top', [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], [0, 1, 0], sx, sz, [colTop, colTop, colTop, colTop]);
    // -Y Bottom
    addFace('bottom', [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], [0, -1, 0], sx, sz, [colBot, colBot, colBot, colBot]);

    return this;
  };

  // ---------------------------------------------------------------------------
  // addBeveledBox(cx, cy, cz, sx, sy, sz, bevel, opts)
  // 6 flat faces + 12 beveled edges + 8 corner bevel triangles (catches specular!)
  // ---------------------------------------------------------------------------
  Builder.prototype.addBeveledBox = function (cx, cy, cz, sx, sy, sz, bevel, opts) {
    const o = opts || {};
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const b = Math.min(Math.max(bevel || 0.02, 0.0005), hx * 0.45, hy * 0.45, hz * 0.45);
    const ix = hx - b, iy = hy - b, iz = hz - b;

    const [us, vs] = parseUVScale(o.uvScale);
    const unitUV = !!o.unitUV;
    const baseCol = parseColor(o.color);
    const aoBot = o.aoBottom !== undefined ? o.aoBottom : 1.0;
    const aoTop = o.aoTop !== undefined ? o.aoTop : 1.0;
    const hasRot = !!(o.rotX || o.rotY || o.rotZ);
    const rot = hasRot ? buildRot3(o.rotX, o.rotY, o.rotZ) : null;

    const xformP = (x, y, z) => {
      if (!rot) return [cx + x, cy + y, cz + z];
      const r = applyRot(rot, x, y, z);
      return [cx + r[0], cy + r[1], cz + r[2]];
    };
    const xformN = (x, y, z) => {
      const n = normalize3(x, y, z);
      return rot ? applyRot(rot, n[0], n[1], n[2]) : n;
    };
    const colAtY = (y) => {
      const t = hy > 1e-6 ? (y + hy) / (2 * hy) : 0.5;
      const ao = aoBot + (aoTop - aoBot) * t;
      return [baseCol[0] * ao, baseCol[1] * ao, baseCol[2] * ao];
    };

    const quad = (p0, p1, p2, p3, n, w, h) => {
      const uw = (unitUV ? 1 : w) * us;
      const vh = (unitUV ? 1 : h) * vs;
      this._pushQuadOriented(
        xformP(p0[0], p0[1], p0[2]),
        xformP(p1[0], p1[1], p1[2]),
        xformP(p2[0], p2[1], p2[2]),
        xformP(p3[0], p3[1], p3[2]),
        xformN(n[0], n[1], n[2]),
        [0, 0], [uw, 0], [uw, vh], [0, vh],
        colAtY(p0[1]), colAtY(p1[1]), colAtY(p2[1]), colAtY(p3[1])
      );
    };

    const bw = b * 1.41421356;

    // 6 main flat faces
    quad([-ix, -iy, hz], [ix, -iy, hz], [ix, iy, hz], [-ix, iy, hz], [0, 0, 1], ix * 2, iy * 2);
    quad([ix, -iy, -hz], [-ix, -iy, -hz], [-ix, iy, -hz], [ix, iy, -hz], [0, 0, -1], ix * 2, iy * 2);
    quad([hx, -iy, iz], [hx, -iy, -iz], [hx, iy, -iz], [hx, iy, iz], [1, 0, 0], iz * 2, iy * 2);
    quad([-hx, -iy, -iz], [-hx, -iy, iz], [-hx, iy, iz], [-hx, iy, -iz], [-1, 0, 0], iz * 2, iy * 2);
    quad([-ix, hy, iz], [ix, hy, iz], [ix, hy, -iz], [-ix, hy, -iz], [0, 1, 0], ix * 2, iz * 2);
    quad([-ix, -hy, -iz], [ix, -hy, -iz], [ix, -hy, iz], [-ix, -hy, iz], [0, -1, 0], ix * 2, iz * 2);

    // 4 edges parallel to X (top/bottom x front/back)
    quad([-ix, iy, hz], [ix, iy, hz], [ix, hy, iz], [-ix, hy, iz], [0, 1, 1], ix * 2, bw);
    quad([ix, iy, -hz], [-ix, iy, -hz], [-ix, hy, -iz], [ix, hy, -iz], [0, 1, -1], ix * 2, bw);
    quad([-ix, -hy, iz], [ix, -hy, iz], [ix, -iy, hz], [-ix, -iy, hz], [0, -1, 1], ix * 2, bw);
    quad([ix, -hy, -iz], [-ix, -hy, -iz], [-ix, -iy, -hz], [ix, -iy, -hz], [0, -1, -1], ix * 2, bw);

    // 4 edges parallel to Z (top/bottom x left/right)
    quad([hx, iy, iz], [hx, iy, -iz], [ix, hy, -iz], [ix, hy, iz], [1, 1, 0], iz * 2, bw);
    quad([-hx, iy, -iz], [-hx, iy, iz], [-ix, hy, iz], [-ix, hy, -iz], [-1, 1, 0], iz * 2, bw);
    quad([ix, -hy, iz], [ix, -hy, -iz], [hx, -iy, -iz], [hx, -iy, iz], [1, -1, 0], iz * 2, bw);
    quad([-ix, -hy, -iz], [-ix, -hy, iz], [-hx, -iy, iz], [-hx, -iy, -iz], [-1, -1, 0], iz * 2, bw);

    // 4 vertical edges parallel to Y (front/back x left/right)
    quad([ix, -iy, hz], [hx, -iy, iz], [hx, iy, iz], [ix, iy, hz], [1, 0, 1], bw, iy * 2);
    quad([-hx, -iy, iz], [-ix, -iy, hz], [-ix, iy, hz], [-hx, iy, iz], [-1, 0, 1], bw, iy * 2);
    quad([hx, -iy, -iz], [ix, -iy, -hz], [ix, iy, -hz], [hx, iy, -iz], [1, 0, -1], bw, iy * 2);
    quad([-ix, -iy, -hz], [-hx, -iy, -iz], [-hx, iy, -iz], [-ix, iy, -hz], [-1, 0, -1], bw, iy * 2);

    // 8 triangular corners
    const signs = [-1, 1];
    for (let sxSign of signs) {
      for (let sySign of signs) {
        for (let szSign of signs) {
          const px = [hx * sxSign, iy * sySign, iz * szSign];
          const py = [ix * sxSign, hy * sySign, iz * szSign];
          const pz = [ix * sxSign, iy * sySign, hz * szSign];
          this._pushTriOriented(
            xformP(px[0], px[1], px[2]),
            xformP(py[0], py[1], py[2]),
            xformP(pz[0], pz[1], pz[2]),
            xformN(sxSign, sySign, szSign),
            [0, 0], [bw * us, 0], [bw * 0.5 * us, bw * vs],
            colAtY(px[1]), colAtY(py[1]), colAtY(pz[1])
          );
        }
      }
    }

    return this;
  };

  // ---------------------------------------------------------------------------
  // addCylinder(cx, cy, cz, rTop, rBot, h, segs, opts)
  // ---------------------------------------------------------------------------
  Builder.prototype.addCylinder = function (cx, cy, cz, rTop, rBot, h, segs, opts) {
    const o = opts || {};
    const nSegs = Math.max(3, Math.floor(segs || 16));
    const axis = o.axis || 'y';
    const open = !!o.openEnded;
    const capTop = open ? false : (o.capTop !== undefined ? !!o.capTop : rTop > 1e-5);
    const capBot = open ? false : (o.capBot !== undefined ? !!o.capBot : rBot > 1e-5);
    const [us, vs] = parseUVScale(o.uvScale);
    const c = parseColor(o.color);
    const aoBot = o.aoBottom !== undefined ? o.aoBottom : 1.0;
    const aoTop = o.aoTop !== undefined ? o.aoTop : 1.0;
    const cBot = [c[0] * aoBot, c[1] * aoBot, c[2] * aoBot];
    const cTop = [c[0] * aoTop, c[1] * aoTop, c[2] * aoTop];
    const halfH = h * 0.5;
    const hasRot = !!(o.rotX || o.rotY || o.rotZ);
    const rot = hasRot ? buildRot3(o.rotX, o.rotY, o.rotZ) : null;

    const orient = (x, y, z) => {
      let ox, oy, oz;
      if (axis === 'x') {
        ox = y; oy = -x; oz = z;
      } else if (axis === 'z') {
        ox = x; oy = -z; oz = y;
      } else {
        ox = x; oy = y; oz = z;
      }
      return rot ? applyRot(rot, ox, oy, oz) : [ox, oy, oz];
    };

    const pWorld = (x, y, z) => {
      const p = orient(x, y, z);
      return [cx + p[0], cy + p[1], cz + p[2]];
    };
    const nWorld = (x, y, z) => {
      const n = orient(x, y, z);
      return normalize3(n[0], n[1], n[2]);
    };

    const slope = (rBot - rTop) / Math.max(h, 1e-5);
    const circum = Math.PI * (rTop + rBot);
    const uMax = (o.unitUV ? 1 : Math.max(circum, 0.25)) * us;
    const vMax = (o.unitUV ? 1 : h) * vs;

    const baseIdx = this.verts.length / VERTEX_FLOATS;
    const angleStart = o.angleStart || 0;
    const angleLen = o.angleLength !== undefined ? o.angleLength : Math.PI * 2;

    // Side rings (2 vertices per segment column: bottom, top)
    for (let i = 0; i <= nSegs; i++) {
      const t = i / nSegs;
      const theta = angleStart + t * angleLen;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);

      const n = nWorld(ct, slope, st);
      const pb = pWorld(ct * rBot, -halfH, st * rBot);
      const pt = pWorld(ct * rTop, halfH, st * rTop);

      this._pushVert(pb[0], pb[1], pb[2], n[0], n[1], n[2], t * uMax, 0, cBot[0], cBot[1], cBot[2]);
      this._pushVert(pt[0], pt[1], pt[2], n[0], n[1], n[2], t * uMax, vMax, cTop[0], cTop[1], cTop[2]);
    }

    for (let i = 0; i < nSegs; i++) {
      const b0 = baseIdx + i * 2;
      const t0 = b0 + 1;
      const b1 = b0 + 2;
      const t1 = b0 + 3;
      // Check outward winding: around Y with (cos, sin), increasing theta goes from +X toward +Z (CW from +Y)
      // so (b0, t0, b1) -> cross(t0-b0=(0,1,0), b1-b0=(-sin,0,cos)) = (cos, 0, sin) OUTWARD!
      this.indices.push(b0, t0, b1, t0, t1, b1);
    }

    // Top cap
    if (capTop && rTop > 1e-5) {
      const nTop = nWorld(0, 1, 0);
      const centerP = pWorld(0, halfH, 0);
      const cIdx = this._pushVert(centerP[0], centerP[1], centerP[2], nTop[0], nTop[1], nTop[2], 0.5 * us, 0.5 * vs, cTop[0], cTop[1], cTop[2]);
      const ringStart = this.verts.length / VERTEX_FLOATS;
      for (let i = 0; i <= nSegs; i++) {
        const theta = angleStart + (i / nSegs) * angleLen;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const p = pWorld(ct * rTop, halfH, st * rTop);
        const u = (0.5 + ct * 0.5) * (o.unitUV ? 1 : rTop * 2) * us;
        const v = (0.5 + st * 0.5) * (o.unitUV ? 1 : rTop * 2) * vs;
        this._pushVert(p[0], p[1], p[2], nTop[0], nTop[1], nTop[2], u, v, cTop[0], cTop[1], cTop[2]);
      }
      for (let i = 0; i < nSegs; i++) {
        // Outward +Y: (center, i+1, i)
        this.indices.push(cIdx, ringStart + i + 1, ringStart + i);
      }
    }

    // Bottom cap
    if (capBot && rBot > 1e-5) {
      const nBot = nWorld(0, -1, 0);
      const centerP = pWorld(0, -halfH, 0);
      const cIdx = this._pushVert(centerP[0], centerP[1], centerP[2], nBot[0], nBot[1], nBot[2], 0.5 * us, 0.5 * vs, cBot[0], cBot[1], cBot[2]);
      const ringStart = this.verts.length / VERTEX_FLOATS;
      for (let i = 0; i <= nSegs; i++) {
        const theta = angleStart + (i / nSegs) * angleLen;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const p = pWorld(ct * rBot, -halfH, st * rBot);
        const u = (0.5 + ct * 0.5) * (o.unitUV ? 1 : rBot * 2) * us;
        const v = (0.5 - st * 0.5) * (o.unitUV ? 1 : rBot * 2) * vs;
        this._pushVert(p[0], p[1], p[2], nBot[0], nBot[1], nBot[2], u, v, cBot[0], cBot[1], cBot[2]);
      }
      for (let i = 0; i < nSegs; i++) {
        // Outward -Y: (center, i, i+1)
        this.indices.push(cIdx, ringStart + i, ringStart + i + 1);
      }
    }

    return this;
  };

  // ---------------------------------------------------------------------------
  // addSphere(cx, cy, cz, r, segsU, segsV, opts)
  // ---------------------------------------------------------------------------
  Builder.prototype.addSphere = function (cx, cy, cz, r, segsU, segsV, opts) {
    const o = opts || {};
    const nu = Math.max(4, Math.floor(segsU || 16));
    const nv = Math.max(3, Math.floor(segsV || 12));
    const [us, vs] = parseUVScale(o.uvScale);
    const c = parseColor(o.color);
    const sc = o.scale ? (typeof o.scale === 'number' ? [o.scale, o.scale, o.scale] : o.scale) : [1, 1, 1];
    const hasRot = !!(o.rotX || o.rotY || o.rotZ);
    const rot = hasRot ? buildRot3(o.rotX, o.rotY, o.rotZ) : null;

    let phiStart = 0;
    let phiEnd = Math.PI;
    if (o.hemi === 'top') phiEnd = Math.PI * 0.5;
    else if (o.hemi === 'bottom') phiStart = Math.PI * 0.5;

    const baseIdx = this.verts.length / VERTEX_FLOATS;
    for (let iv = 0; iv <= nv; iv++) {
      const vFrac = iv / nv;
      const phi = phiStart + vFrac * (phiEnd - phiStart);
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);

      for (let iu = 0; iu <= nu; iu++) {
        const uFrac = iu / nu;
        const theta = uFrac * Math.PI * 2;
        const ct = Math.cos(theta);
        const st = Math.sin(theta);

        const lx = sp * ct * r * sc[0];
        const ly = cp * r * sc[1];
        const lz = sp * st * r * sc[2];

        let nx = (sp * ct) / Math.max(sc[0], 1e-4);
        let ny = cp / Math.max(sc[1], 1e-4);
        let nz = (sp * st) / Math.max(sc[2], 1e-4);
        let p = [lx, ly, lz];
        let n = normalize3(nx, ny, nz);
        if (rot) {
          p = applyRot(rot, p[0], p[1], p[2]);
          n = normalize3(...applyRot(rot, n[0], n[1], n[2]));
        }

        this._pushVert(
          cx + p[0], cy + p[1], cz + p[2],
          n[0], n[1], n[2],
          uFrac * us, (1 - vFrac) * vs,
          c[0], c[1], c[2]
        );
      }
    }

    const row = nu + 1;
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu; iu++) {
        const a = baseIdx + iv * row + iu;
        const b = a + 1;
        const d = a + row;
        const e = d + 1;
        // As iv increases (phi goes 0->PI, +Y->-Y), d is below a.
        // As iu increases (theta +X->+Z), b is CW from top.
        // Outward normal: (a, b, d) -> cross(b-a=(-st,0,ct), d-a=(cp*ct,-sp,cp*st)) = (+sp*ct, +cp, +sp*st) OUTWARD!
        if (iv > 0 || phiStart > 0) this.indices.push(a, b, d);
        if (iv < nv - 1 || phiEnd < Math.PI) this.indices.push(b, e, d);
      }
    }

    return this;
  };

  // ---------------------------------------------------------------------------
  // addWedge / addPrism(cx, cy, cz, sx, sy, sz, opts)
  // Default: bottom full, back wall (-Z) full height, front (+Z) sloped down to -sy/2
  // Supports opts.topZ (0..1, 0 = classic wedge, >0 = sloped trapezoidal prism / tank turret)
  // ---------------------------------------------------------------------------
  Builder.prototype.addWedge = function (cx, cy, cz, sx, sy, sz, opts) {
    const o = opts || {};
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const [us, vs] = parseUVScale(o.uvScale);
    const c = parseColor(o.color);
    const hasRot = !!(o.rotX || o.rotY || o.rotZ);
    const rot = hasRot ? buildRot3(o.rotX, o.rotY, o.rotZ) : null;

    const xformP = (x, y, z) => {
      if (!rot) return [cx + x, cy + y, cz + z];
      const r = applyRot(rot, x, y, z);
      return [cx + r[0], cy + r[1], cz + r[2]];
    };
    const xformN = (x, y, z) => {
      const n = normalize3(x, y, z);
      return rot ? applyRot(rot, n[0], n[1], n[2]) : n;
    };

    const topRatio = o.topZ !== undefined ? Math.max(0, Math.min(1, o.topZ)) : 0;

    if (topRatio > 1e-4) {
      // Trapezoidal prism (front & optionally back sloped)
      const topFrontZ = -hz + sz * topRatio;
      const topBackZ = -hz;
      const pBLF = xformP(-hx, -hy, hz), pBRF = xformP(hx, -hy, hz);
      const pBLB = xformP(-hx, -hy, -hz), pBRB = xformP(hx, -hy, -hz);
      const pTLF = xformP(-hx, hy, topFrontZ), pTRF = xformP(hx, hy, topFrontZ);
      const pTLB = xformP(-hx, hy, topBackZ), pTRB = xformP(hx, hy, topBackZ);

      const slopeLen = Math.hypot(hz - topFrontZ, sy);
      const slopeN = xformN(0, hz - topFrontZ, sy);

      // Bottom
      this._pushQuadOriented(pBLB, pBRB, pBRF, pBLF, xformN(0, -1, 0), [0, 0], [sx * us, 0], [sx * us, sz * vs], [0, sz * vs], c, c, c, c);
      // Top
      this._pushQuadOriented(pTLF, pTRF, pTRB, pTLB, xformN(0, 1, 0), [0, 0], [sx * us, 0], [sx * us, sz * topRatio * vs], [0, sz * topRatio * vs], c, c, c, c);
      // Back (-Z)
      this._pushQuadOriented(pBRB, pBLB, pTLB, pTRB, xformN(0, 0, -1), [0, 0], [sx * us, 0], [sx * us, sy * vs], [0, sy * vs], c, c, c, c);
      // Front Sloped
      this._pushQuadOriented(pBLF, pBRF, pTRF, pTLF, slopeN, [0, 0], [sx * us, 0], [sx * us, slopeLen * vs], [0, slopeLen * vs], c, c, c, c);
      // Right (+X)
      this._pushQuadOriented(pBRF, pBRB, pTRB, pTRF, xformN(1, 0, 0), [0, 0], [sz * us, 0], [sz * us, sy * vs], [sz * (1 - topRatio) * us, sy * vs], c, c, c, c);
      // Left (-X)
      this._pushQuadOriented(pBLB, pBLF, pTLF, pTLB, xformN(-1, 0, 0), [0, 0], [sz * us, 0], [sz * topRatio * us, sy * vs], [0, sy * vs], c, c, c, c);
      return this;
    }

    // Classic 5-face triangular wedge
    const pBLF = xformP(-hx, -hy, hz);
    const pBRF = xformP(hx, -hy, hz);
    const pBLB = xformP(-hx, -hy, -hz);
    const pBRB = xformP(hx, -hy, -hz);
    const pTLB = xformP(-hx, hy, -hz);
    const pTRB = xformP(hx, hy, -hz);

    const slopeLen = Math.hypot(sz, sy);
    const slopeN = xformN(0, sz, sy);

    // Bottom (-Y)
    this._pushQuadOriented(pBLB, pBRB, pBRF, pBLF, xformN(0, -1, 0), [0, 0], [sx * us, 0], [sx * us, sz * vs], [0, sz * vs], c, c, c, c);
    // Back (-Z)
    this._pushQuadOriented(pBRB, pBLB, pTLB, pTRB, xformN(0, 0, -1), [0, 0], [sx * us, 0], [sx * us, sy * vs], [0, sy * vs], c, c, c, c);
    // Sloped face (+Y/+Z)
    this._pushQuadOriented(pBLF, pBRF, pTRB, pTLB, slopeN, [0, 0], [sx * us, 0], [sx * us, slopeLen * vs], [0, slopeLen * vs], c, c, c, c);
    // Right triangle (+X)
    this._pushTriOriented(pBRF, pBRB, pTRB, xformN(1, 0, 0), [0, 0], [sz * us, 0], [sz * us, sy * vs], c, c, c);
    // Left triangle (-X)
    this._pushTriOriented(pBLB, pBLF, pTLB, xformN(-1, 0, 0), [0, 0], [sz * us, 0], [0, sy * vs], c, c, c);

    return this;
  };

  Builder.prototype.addPrism = Builder.prototype.addWedge;

  // ---------------------------------------------------------------------------
  // addTube(points, radius, segs, opts)
  // Parallel-transport (Bishop) frames along 3D polyline — twist-free!
  // ---------------------------------------------------------------------------
  Builder.prototype.addTube = function (points, radius, segs, opts) {
    if (!points || points.length < 2) return this;
    const o = opts || {};
    const nSegs = Math.max(3, Math.floor(segs || 10));
    const [us, vs] = parseUVScale(o.uvScale);
    const c = parseColor(o.color);
    const capStart = o.capStart !== undefined ? !!o.capStart : true;
    const capEnd = o.capEnd !== undefined ? !!o.capEnd : true;
    const count = points.length;

    const getRad = (i) => (Array.isArray(radius) ? radius[Math.min(i, radius.length - 1)] : (radius || 0.05));

    // Compute tangents along polyline
    const tangents = new Array(count);
    for (let i = 0; i < count; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(count - 1, i + 1)];
      tangents[i] = normalize3(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    }

    // Initial normal perpendicular to tangents[0]
    const t0 = tangents[0];
    let ref = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let nCur = normalize3(
      ref[1] * t0[2] - ref[2] * t0[1],
      ref[2] * t0[0] - ref[0] * t0[2],
      ref[0] * t0[1] - ref[1] * t0[0]
    );
    let bCur = normalize3(
      t0[1] * nCur[2] - t0[2] * nCur[1],
      t0[2] * nCur[0] - t0[0] * nCur[2],
      t0[0] * nCur[1] - t0[1] * nCur[0]
    );

    const frames = [{ n: nCur, b: bCur }];
    const lengths = [0];

    for (let i = 1; i < count; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      const dz = points[i][2] - points[i - 1][2];
      lengths.push(lengths[i - 1] + Math.hypot(dx, dy, dz));

      // Parallel transport nCur onto plane perpendicular to tangents[i]
      const ti = tangents[i];
      const dot = nCur[0] * ti[0] + nCur[1] * ti[1] + nCur[2] * ti[2];
      nCur = normalize3(nCur[0] - ti[0] * dot, nCur[1] - ti[1] * dot, nCur[2] - ti[2] * dot);
      bCur = normalize3(
        ti[1] * nCur[2] - ti[2] * nCur[1],
        ti[2] * nCur[0] - ti[0] * nCur[2],
        ti[0] * nCur[1] - ti[1] * nCur[0]
      );
      frames.push({ n: nCur, b: bCur });
    }

    const baseIdx = this.verts.length / VERTEX_FLOATS;
    const avgR = Array.isArray(radius) ? radius[0] : (radius || 0.05);
    const circum = Math.max(Math.PI * 2 * avgR, 0.1);

    for (let i = 0; i < count; i++) {
      const p = points[i];
      const r = getRad(i);
      const f = frames[i];
      const vCoord = lengths[i] * vs;

      for (let s = 0; s <= nSegs; s++) {
        const frac = s / nSegs;
        const theta = frac * Math.PI * 2;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const nx = f.n[0] * ct + f.b[0] * st;
        const ny = f.n[1] * ct + f.b[1] * st;
        const nz = f.n[2] * ct + f.b[2] * st;
        this._pushVert(
          p[0] + nx * r, p[1] + ny * r, p[2] + nz * r,
          nx, ny, nz,
          frac * circum * us, vCoord,
          c[0], c[1], c[2]
        );
      }
    }

    const ringStride = nSegs + 1;
    for (let i = 0; i < count - 1; i++) {
      for (let s = 0; s < nSegs; s++) {
        const a = baseIdx + i * ringStride + s;
        const b = a + 1;
        const d = a + ringStride;
        const e = d + 1;
        // Since bCur = cross(T, nCur), increasing theta goes from n toward b (CCW around +T)
        // Tangent is along +i (d - a). So (a, b, d) -> cross(b-a ~ +b, d-a ~ +T) = -n!
        // Thus outward normal is (a, d, b) and (b, d, e).
        this.indices.push(a, d, b, b, d, e);
      }
    }

    if (capStart && getRad(0) > 1e-5) {
      const p0 = points[0], r0 = getRad(0), f0 = frames[0], tStart = tangents[0];
      const n = [-tStart[0], -tStart[1], -tStart[2]];
      const cIdx = this._pushVert(p0[0], p0[1], p0[2], n[0], n[1], n[2], 0.5, 0.5, c[0], c[1], c[2]);
      const start = this.verts.length / VERTEX_FLOATS;
      for (let s = 0; s <= nSegs; s++) {
        const theta = (s / nSegs) * Math.PI * 2;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const px = p0[0] + (f0.n[0] * ct + f0.b[0] * st) * r0;
        const py = p0[1] + (f0.n[1] * ct + f0.b[1] * st) * r0;
        const pz = p0[2] + (f0.n[2] * ct + f0.b[2] * st) * r0;
        this._pushVert(px, py, pz, n[0], n[1], n[2], 0.5 + ct * 0.5, 0.5 + st * 0.5, c[0], c[1], c[2]);
      }
      for (let s = 0; s < nSegs; s++) {
        this.indices.push(cIdx, start + s + 1, start + s);
      }
    }

    if (capEnd && getRad(count - 1) > 1e-5) {
      const pe = points[count - 1], re = getRad(count - 1), fe = frames[count - 1], te = tangents[count - 1];
      const cIdx = this._pushVert(pe[0], pe[1], pe[2], te[0], te[1], te[2], 0.5, 0.5, c[0], c[1], c[2]);
      const start = this.verts.length / VERTEX_FLOATS;
      for (let s = 0; s <= nSegs; s++) {
        const theta = (s / nSegs) * Math.PI * 2;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const px = pe[0] + (fe.n[0] * ct + fe.b[0] * st) * re;
        const py = pe[1] + (fe.n[1] * ct + fe.b[1] * st) * re;
        const pz = pe[2] + (fe.n[2] * ct + fe.b[2] * st) * re;
        this._pushVert(px, py, pz, te[0], te[1], te[2], 0.5 + ct * 0.5, 0.5 + st * 0.5, c[0], c[1], c[2]);
      }
      for (let s = 0; s < nSegs; s++) {
        this.indices.push(cIdx, start + s, start + s + 1);
      }
    }

    return this;
  };

  // ---------------------------------------------------------------------------
  // mergeRaw(verts, indices) — accepts flat 15-float array OR array of vertex objects
  // ---------------------------------------------------------------------------
  Builder.prototype.mergeRaw = function (verts, indices) {
    if (!verts || verts.length === 0) return this;
    const base = this.verts.length / VERTEX_FLOATS;

    if (typeof verts[0] === 'number') {
      for (let i = 0; i < verts.length; i++) {
        this.verts.push(verts[i]);
      }
    } else {
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const p = v.pos || [0, 0, 0];
        const n = v.normal || [0, 1, 0];
        const uv = v.uv || [0, 0];
        const t = v.tangent || [1, 0, 0, 1];
        const c = v.color || [1, 1, 1];
        this.verts.push(
          p[0], p[1], p[2],
          n[0], n[1], n[2],
          uv[0], uv[1],
          t[0], t[1], t[2], t[3] !== undefined ? t[3] : 1,
          c[0], c[1], c[2]
        );
      }
    }

    if (indices && indices.length > 0) {
      for (let i = 0; i < indices.length; i++) {
        this.indices.push(base + indices[i]);
      }
    }
    this._tangentsComputed = false;
    return this;
  };

  // ---------------------------------------------------------------------------
  // computeTangents() — MikkTSpace-style UV tangent + handedness (tx, ty, tz, w)
  // ---------------------------------------------------------------------------
  Builder.prototype.computeTangents = function () {
    const vCount = this.verts.length / VERTEX_FLOATS;
    if (vCount === 0) return this;

    const tan1 = new Float32Array(vCount * 3);
    const tan2 = new Float32Array(vCount * 3);
    const verts = this.verts;
    const idx = this.indices;

    for (let i = 0; i + 2 < idx.length; i += 3) {
      const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
      const o0 = i0 * VERTEX_FLOATS;
      const o1 = i1 * VERTEX_FLOATS;
      const o2 = i2 * VERTEX_FLOATS;

      const x1 = verts[o1] - verts[o0];
      const y1 = verts[o1 + 1] - verts[o0 + 1];
      const z1 = verts[o1 + 2] - verts[o0 + 2];
      const x2 = verts[o2] - verts[o0];
      const y2 = verts[o2 + 1] - verts[o0 + 1];
      const z2 = verts[o2 + 2] - verts[o0 + 2];

      const s1 = verts[o1 + 6] - verts[o0 + 6];
      const t1 = verts[o1 + 7] - verts[o0 + 7];
      const s2 = verts[o2 + 6] - verts[o0 + 6];
      const t2 = verts[o2 + 7] - verts[o0 + 7];

      const det = s1 * t2 - s2 * t1;
      if (Math.abs(det) < 1e-10) continue;
      const r = 1.0 / det;

      const sx = (t2 * x1 - t1 * x2) * r;
      const sy = (t2 * y1 - t1 * y2) * r;
      const sz = (t2 * z1 - t1 * z2) * r;

      const tx = (s1 * x2 - s2 * x1) * r;
      const ty = (s1 * y2 - s2 * y1) * r;
      const tz = (s1 * z2 - s2 * z1) * r;

      const k0 = i0 * 3, k1 = i1 * 3, k2 = i2 * 3;
      tan1[k0] += sx; tan1[k0 + 1] += sy; tan1[k0 + 2] += sz;
      tan1[k1] += sx; tan1[k1 + 1] += sy; tan1[k1 + 2] += sz;
      tan1[k2] += sx; tan1[k2 + 1] += sy; tan1[k2 + 2] += sz;

      tan2[k0] += tx; tan2[k0 + 1] += ty; tan2[k0 + 2] += tz;
      tan2[k1] += tx; tan2[k1 + 1] += ty; tan2[k1 + 2] += tz;
      tan2[k2] += tx; tan2[k2 + 1] += ty; tan2[k2 + 2] += tz;
    }

    for (let i = 0; i < vCount; i++) {
      const o = i * VERTEX_FLOATS;
      const k = i * 3;
      const nx = verts[o + 3], ny = verts[o + 4], nz = verts[o + 5];
      let t1x = tan1[k], t1y = tan1[k + 1], t1z = tan1[k + 2];

      // Gram-Schmidt orthogonalize
      const ndt = nx * t1x + ny * t1y + nz * t1z;
      let ox = t1x - nx * ndt;
      let oy = t1y - ny * ndt;
      let oz = t1z - nz * ndt;
      let len = Math.hypot(ox, oy, oz);

      let w = 1.0;
      if (len > 1e-6) {
        ox /= len; oy /= len; oz /= len;
        const cx = ny * t1z - nz * t1y;
        const cy = nz * t1x - nx * t1z;
        const cz = nx * t1y - ny * t1x;
        const hand = cx * tan2[k] + cy * tan2[k + 1] + cz * tan2[k + 2];
        w = hand < 0 ? -1.0 : 1.0;
      } else {
        // Fallback orthonormal tangent for degenerate UVs
        const rx = Math.abs(ny) < 0.9 ? 0 : 1;
        const ry = Math.abs(ny) < 0.9 ? 1 : 0;
        const rz = 0;
        ox = ry * nz - rz * ny;
        oy = rz * nx - rx * nz;
        oz = rx * ny - ry * nx;
        len = Math.hypot(ox, oy, oz) || 1;
        ox /= len; oy /= len; oz /= len;
        w = 1.0;
      }

      verts[o + 8] = ox;
      verts[o + 9] = oy;
      verts[o + 10] = oz;
      verts[o + 11] = w;
    }

    this._tangentsComputed = true;
    return this;
  };

  // ---------------------------------------------------------------------------
  // build(gl) — uploads VAO/VBO/IBO + wireframe IBO + AABB bounds
  // ---------------------------------------------------------------------------
  Builder.prototype.build = function (gl) {
    if (!this._tangentsComputed) {
      this.computeTangents();
    }

    const vCount = this.verts.length / VERTEX_FLOATS;
    const iCount = this.indices.length;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.verts.length; i += VERTEX_FLOATS) {
      const x = this.verts[i], y = this.verts[i + 1], z = this.verts[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (vCount === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }

    const vertData = new Float32Array(this.verts);
    const useUint32 = vCount > 65535;
    const indexType = useUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const indexData = useUint32 ? new Uint32Array(this.indices) : new Uint16Array(this.indices);

    // Build deduplicated wireframe edge index buffer
    const edgeSet = new Set();
    const wireArr = [];
    const addEdge = (a, b) => {
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * 1048576 + hi;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        wireArr.push(lo, hi);
      }
    };
    for (let i = 0; i + 2 < iCount; i += 3) {
      const a = this.indices[i], b = this.indices[i + 1], c = this.indices[i + 2];
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }
    const wireData = useUint32 ? new Uint32Array(wireArr) : new Uint16Array(wireArr);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertData, gl.STATIC_DRAW);

    // loc 0: pos (3f)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
    // loc 1: normal (3f)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_STRIDE, 12);
    // loc 2: uv (2f)
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, VERTEX_STRIDE, 24);
    // loc 3: tangent (4f)
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, VERTEX_STRIDE, 32);
    // loc 4: color (3f)
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, VERTEX_STRIDE, 48);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    const wireframeIbo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireframeIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireData, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    return {
      vao,
      vbo,
      ibo,
      indexCount: iCount,
      indexType,
      vertexCount: vCount,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      wireframeIbo,
      wireframeCount: wireArr.length,
      dispose() {
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(vbo);
        gl.deleteBuffer(ibo);
        gl.deleteBuffer(wireframeIbo);
      },
    };
  };

  // ---------------------------------------------------------------------------
  // Cached Primitive Library: DF.MeshGen.Primitives(gl)
  // ---------------------------------------------------------------------------
  const _primCache = new WeakMap();

  function buildRubbleChunk(gl, seed) {
    const rng = new DF.RNG(seed);
    const b = new Builder();
    // Jagged multi-part concrete/masonry rubble chunk resting flush around y=0..0.35
    const mainW = rng.range(0.45, 0.72);
    const mainH = rng.range(0.18, 0.34);
    const mainD = rng.range(0.38, 0.65);
    b.addBeveledBox(0, mainH * 0.5, 0, mainW, mainH, mainD, 0.04, {
      rotY: rng.range(0, Math.PI),
      rotX: rng.range(-0.1, 0.1),
      color: [0.92, 0.90, 0.87],
      aoBottom: 0.72,
    });
    // Secondary fractured wedge & protruding shard
    b.addWedge(rng.range(-0.14, 0.14), mainH * 0.55, rng.range(-0.12, 0.12), mainW * 0.7, mainH * 0.85, mainD * 0.65, {
      rotY: rng.range(0, Math.PI * 2),
      color: [0.84, 0.81, 0.78],
    });
    b.addBeveledBox(rng.range(-0.18, 0.18), mainH * 0.32, rng.range(-0.16, 0.16), mainW * 0.45, mainH * 0.6, mainD * 0.42, {
      rotY: rng.range(0, Math.PI * 2),
      rotZ: rng.range(-0.22, 0.22),
      color: [0.78, 0.76, 0.74],
    });
    return b.build(gl);
  }

  function getPrimitives(gl) {
    if (!gl) return null;
    if (_primCache.has(gl)) return _primCache.get(gl);

    const unitBox = new Builder().addBox(0, 0, 0, 1, 1, 1, { unitUV: true }).build(gl);
    const unitBeveledBox = new Builder().addBeveledBox(0, 0, 0, 1, 1, 1, 0.06, { unitUV: true }).build(gl);
    const unitCylinder = new Builder().addCylinder(0, 0, 0, 0.5, 0.5, 1, 20, { unitUV: true }).build(gl);
    const unitSphere = new Builder().addSphere(0, 0, 0, 0.5, 20, 14).build(gl);
    const unitQuad = new Builder()
      .addQuad([-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], [0, 0], [1, 0], [1, 1], [0, 1])
      .build(gl);

    // High-detail brass rifle shell casing (aligned along Z axis, ~4.5cm long)
    const casingB = new Builder();
    // Rim base
    casingB.addCylinder(0, 0, -0.022, 0.0056, 0.0056, 0.003, 10, { axis: 'z', color: [0.95, 0.82, 0.42] });
    // Main tapered body
    casingB.addCylinder(0, 0, -0.004, 0.0048, 0.0053, 0.032, 10, { axis: 'z', color: [1.0, 0.86, 0.45] });
    // Bottle neck
    casingB.addCylinder(0, 0, 0.0155, 0.0032, 0.0048, 0.007, 10, { axis: 'z', color: [0.92, 0.76, 0.38] });
    // Case mouth
    casingB.addCylinder(0, 0, 0.0215, 0.0032, 0.0032, 0.005, 10, { axis: 'z', capTop: false, color: [0.75, 0.62, 0.32] });
    const shellCasing = casingB.build(gl);

    // 12-gauge shotgun hull (red plastic body + brass head)
    const hullB = new Builder();
    hullB.addCylinder(0, 0, -0.024, 0.0108, 0.0108, 0.003, 10, { axis: 'z', color: [0.96, 0.82, 0.42] });
    hullB.addCylinder(0, 0, -0.016, 0.0100, 0.0100, 0.014, 10, { axis: 'z', color: [0.96, 0.82, 0.42] });
    hullB.addCylinder(0, 0, 0.012, 0.0098, 0.0098, 0.044, 10, { axis: 'z', color: [0.78, 0.14, 0.12] });
    const shotgunShell = hullB.build(gl);

    const rubbleChunkA = buildRubbleChunk(gl, 4091);
    const rubbleChunkB = buildRubbleChunk(gl, 8827);

    // Crossed twin quads along Z axis so tracer streak is visible from any viewing angle
    const tracerB = new Builder();
    const tw = 0.035;
    const tl = 0.5;
    tracerB.addQuad([-tw, 0, -tl], [tw, 0, -tl], [tw, 0, tl], [-tw, 0, tl], [0, 0], [1, 0], [1, 1], [0, 1]);
    tracerB.addQuad([0, -tw, -tl], [0, tw, -tl], [0, tw, tl], [0, -tw, tl], [0, 0], [1, 0], [1, 1], [0, 1]);
    const tracerQuad = tracerB.build(gl);

    const prims = {
      unitBox,
      unitBeveledBox,
      unitCylinder,
      unitSphere,
      unitQuad,
      shellCasing,
      shotgunShell,
      rubbleChunkA,
      rubbleChunkB,
      tracerQuad,
    };
    _primCache.set(gl, prims);
    return prims;
  }

  DF.MeshGen = {
    VERTEX_FLOATS,
    VERTEX_STRIDE,
    Builder,
    Primitives: getPrimitives,
  };
})();
