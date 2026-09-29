/*
 * Orthogonal cable router for hand-placed topology cards (topology.js, manual mode).
 *
 * ELK only routes edges as part of laying the nodes out itself, and elkjs has no
 * "route around fixed obstacles" mode (libavoid isn't in it), so manual mode routes here:
 *   1. A sparse grid: the lines just outside every card (clearance M), every port's stub
 *      point, and the midpoints between neighbouring lines — the channels between cards.
 *   2. A* over that grid per cable, cost = length + a penalty per bend + a penalty per grid
 *      crossing of an earlier cable (and a small one per grid segment it shares).
 *      Cables are routed shortest first, then each is ripped up and rerouted with all the
 *      others in place (REROUTE_PASSES), which undoes most bad early choices.
 *   3. Nudging: cables still sharing a line are fanned apart by GAP so they don't overlap.
 * While a card is being dragged, `cheap` skips all of that for a simple three-segment route
 * so the drag stays smooth; the full route runs on drop.
 */
(function () {
  "use strict";

  const M = 10;          // clearance kept around every card
  const STUB = 18;       // straight run out of a port before the first bend (must exceed M)
  const BEND = 40;       // cost of one bend, in px of extra length
  // Small on purpose: cables sharing a channel get fanned out in a crossing-free order by
  // nudge(); a big penalty scatters them over neighbouring channels in arbitrary order.
  const CROWD = 3;       // cost per earlier cable already using a grid segment
  const CROSS = 60;      // cost of crossing an earlier cable
  const GAP = 6;         // spacing between parallel cables fanned out of a shared line
  const MAX_CELLS = 4e6; // grid size above which we fall back to simple routes
  const MAX_EXPANSIONS = 250000;
  const TIME_BUDGET_MS = 2500;
  const REROUTE_PASSES = 2;

  function compress(pts) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
      out.push({ x: p.x, y: p.y });
    }
    // drop the middle one of three collinear points
    for (let i = out.length - 2; i > 0; i--) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) ||
          (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) out.splice(i, 1);
    }
    return out;
  }

  const stubOf = (end) => ({ x: end.x + end.dir * STUB, y: end.y });

  /** Three-segment route ignoring obstacles — used while dragging and as a fallback. */
  function simpleRoute(s, t) {
    const a = stubOf(s), b = stubOf(t);
    let mid;
    if (s.dir !== t.dir) {
      if ((b.x - a.x) * s.dir >= 0) { // ports face each other
        const mx = (a.x + b.x) / 2;
        mid = [{ x: mx, y: a.y }, { x: mx, y: b.y }];
      } else {
        const my = (a.y + b.y) / 2;
        mid = [{ x: a.x, y: my }, { x: b.x, y: my }];
      }
    } else {
      const x = s.dir > 0 ? Math.max(a.x, b.x) : Math.min(a.x, b.x);
      mid = [{ x, y: a.y }, { x, y: b.y }];
    }
    return compress([s, a].concat(mid, [b, t]));
  }

  // ------------------------------------------------------------------ grid
  function uniqSorted(values) {
    values.sort((p, q) => p - q);
    const out = [];
    for (const v of values) if (!out.length || v - out[out.length - 1] > 0.5) out.push(v);
    return out;
  }
  function withMidpoints(a) {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      out.push(a[i]);
      if (i < a.length - 1 && a[i + 1] - a[i] > 4) out.push((a[i] + a[i + 1]) / 2);
    }
    return out;
  }
  // first index with a[i] > v (strict) / nearest index
  function upper(a, v) {
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; }
    return lo;
  }
  function nearest(a, v) {
    const i = upper(a, v);
    if (i === 0) return 0;
    if (i === a.length) return a.length - 1;
    return v - a[i - 1] <= a[i] - v ? i - 1 : i;
  }

  function buildGrid(rects, stubs) {
    const xs = [], ys = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rects) {
      xs.push(r.x - M, r.x + r.w + M);
      ys.push(r.y - M, r.y + r.h + M);
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    for (const p of stubs) { xs.push(p.x); ys.push(p.y); }
    // an outer ring so there's always a way around everything
    xs.push(minX - 4 * M, maxX + 4 * M);
    ys.push(minY - 4 * M, maxY + 4 * M);
    const gx = withMidpoints(uniqSorted(xs));
    const gy = withMidpoints(uniqSorted(ys));
    const nx = gx.length, ny = gy.length;
    if (nx * ny > MAX_CELLS) return null;
    const blocked = new Uint8Array(nx * ny);
    for (const r of rects) {
      const i0 = upper(gx, r.x - M), i1 = upper(gx, r.x + r.w + M - 0.01);
      const j0 = upper(gy, r.y - M), j1 = upper(gy, r.y + r.h + M - 0.01);
      for (let i = i0; i < i1; i++) blocked.fill(1, i * ny + j0, i * ny + j1);
    }
    return {
      gx, gy, nx, ny, blocked,
      g: new Float64Array(nx * ny * 2),
      prev: new Int32Array(nx * ny * 2),
      stamp: new Int32Array(nx * ny * 2),
      closed: new Int32Array(nx * ny * 2),
      usage: new Uint16Array(nx * ny * 2),
      // cell * 2 + axis: some earlier cable passes through this cell along that axis
      through: new Uint16Array(nx * ny * 2),
      run: 0,
    };
  }

  // ------------------------------------------------------------------ A*
  // State = cell * 2 + axis (0: arrived moving horizontally, 1: vertically).
  function astar(G, s, t) {
    const { gx, gy, ny, blocked, g, prev, stamp, closed, usage, through } = G;
    const run = ++G.run;
    const a = stubOf(s), b = stubOf(t);
    const si = nearest(gx, a.x), sj = nearest(gy, a.y);
    const ti = nearest(gx, b.x), tj = nearest(gy, b.y);
    const start = (si * ny + sj) * 2, goalCell = ti * ny + tj;
    const bx = gx[ti], by = gy[tj];

    // binary heap of [f, state]
    const hf = [], hs = [];
    function push(f, st) {
      let i = hf.length;
      hf.push(f); hs.push(st);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hf[p] <= f) break;
        hf[i] = hf[p]; hs[i] = hs[p]; i = p;
      }
      hf[i] = f; hs[i] = st;
    }
    function pop() {
      const top = hs[0];
      const lf = hf.pop(), ls = hs.pop();
      if (hf.length) {
        let i = 0;
        const n = hf.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && hf[c + 1] < hf[c]) c++;
          if (hf[c] >= lf) break;
          hf[i] = hf[c]; hs[i] = hs[c]; i = c;
        }
        hf[i] = lf; hs[i] = ls;
      }
      return top;
    }

    stamp[start] = run; g[start] = 0; prev[start] = -1;
    push(Math.abs(gx[si] - bx) + Math.abs(gy[sj] - by), start);
    let expansions = 0;
    let found = -1;
    while (hf.length) {
      const st = pop();
      if (closed[st] === run) continue;
      closed[st] = run;
      const cell = st >> 1, axis = st & 1;
      if (cell === goalCell) { found = st; break; }
      if (++expansions > MAX_EXPANSIONS) break;
      const i = (cell / ny) | 0, j = cell - i * ny;
      for (let k = 0; k < 4; k++) {
        const di = k === 0 ? 1 : k === 1 ? -1 : 0;
        const dj = k === 2 ? 1 : k === 3 ? -1 : 0;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= G.nx || nj >= ny) continue;
        const ncell = ni * ny + nj;
        if (blocked[ncell] && ncell !== goalCell) continue;
        // Don't leave a port back toward its own card, or arrive at one from behind it.
        if (st === start && di === -s.dir) continue;
        if (ncell === goalCell && di === t.dir) continue;
        const naxis = di ? 0 : 1;
        const seg = di ? (Math.min(i, ni) * ny + j) * 2 : (i * ny + Math.min(j, nj)) * 2 + 1;
        const len = di ? Math.abs(gx[ni] - gx[i]) : Math.abs(gy[nj] - gy[j]);
        let cost = g[st] + len + usage[seg] * CROWD + (naxis !== axis ? BEND : 0);
        if (ncell === goalCell && naxis !== 0) cost += BEND; // the last run into a port is horizontal
        if (through[ncell * 2 + 1 - naxis]) cost += CROSS;
        // The stub out of the port is horizontal too: leaving across a cable already
        // running through the stub point is a crossing as well.
        if (st === start && naxis === 0 && through[cell * 2 + 1]) cost += CROSS;
        const ns = ncell * 2 + naxis;
        if (stamp[ns] === run && g[ns] <= cost) continue;
        stamp[ns] = run; g[ns] = cost; prev[ns] = st;
        push(cost + Math.abs(gx[ni] - bx) + Math.abs(gy[nj] - by), ns);
      }
    }
    if (found < 0) return null;

    const cells = [];
    for (let st = found; st !== -1; st = prev[st]) cells.push(st >> 1);
    cells.reverse();
    const pts = cells.map((c) => { const ci = (c / ny) | 0; return { x: gx[ci], y: gy[c - ci * ny] }; });
    return {
      cells,
      // Snap the grid's nearest points back onto the exact stub coordinates.
      pts: compress([s, a, { x: pts[0].x, y: a.y }].concat(pts, [{ x: pts[pts.length - 1].x, y: b.y }, b, t])),
    };
  }

  // Record (delta = 1) or remove (delta = -1) a routed cable's footprint on the grid.
  function commit(G, cells, delta) {
    const { ny, usage, through } = G;
    const axes = [];
    for (let k = 1; k < cells.length; k++) {
      const c0 = cells[k - 1], c1 = cells[k];
      const i0 = (c0 / ny) | 0, j0 = c0 - i0 * ny, i1 = (c1 / ny) | 0, j1 = c1 - i1 * ny;
      const seg = i0 !== i1 ? (Math.min(i0, i1) * ny + j0) * 2 : (i0 * ny + Math.min(j0, j1)) * 2 + 1;
      usage[seg] += delta;
      axes.push(i0 !== i1 ? 0 : 1);
    }
    // Only cells the cable runs straight through count for crossings: at a corner another
    // cable can share the line and nudge() still separates the two without a crossing.
    for (let k = 1; k < axes.length; k++) {
      if (axes[k] === axes[k - 1]) through[cells[k] * 2 + axes[k]] += delta;
    }
  }

  // ------------------------------------------------------------------ nudging
  // Segments that share a line and overlap are spread GAP apart, centred on the line. Only
  // interior segments move — the first and last run are pinned to their port's height.
  //
  // Order within a bundle: each end of a segment turns off to one side (for a vertical
  // segment: left or right). With a placed before b (left of / above), a's ends that turn
  // toward b cross b if they lie within b's span, and b's ends turning toward a likewise —
  // so a goes first when that costs fewer crossings than the other way round.
  function crossings(a, b) {
    let n = 0;
    for (const e of a.ends) if (e.side > 0 && e.at > b.lo && e.at < b.hi) n++;
    for (const e of b.ends) if (e.side < 0 && e.at > a.lo && e.at < a.hi) n++;
    return n;
  }
  function orderBundle(segs) {
    const out = [];
    for (const s of segs) {
      let i = out.length;
      while (i > 0 && crossings(s, out[i - 1]) < crossings(out[i - 1], s)) i--;
      out.splice(i, 0, s);
    }
    return out;
  }
  function nudge(paths) {
    const groups = new Map();
    paths.forEach((pts, pi) => {
      for (let k = 1; k < pts.length - 2; k++) {
        const p = pts[k], q = pts[k + 1];
        const vertical = Math.abs(p.x - q.x) < 0.01;
        const along = vertical ? "y" : "x", across = vertical ? "x" : "y";
        const key = (vertical ? "v" : "h") + Math.round(p[across]);
        const ends = [
          { at: p[along], side: Math.sign(pts[k - 1][across] - p[across]) },
          { at: q[along], side: Math.sign(pts[k + 2][across] - q[across]) },
        ];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ pi, k, lo: Math.min(p[along], q[along]), hi: Math.max(p[along], q[along]), vertical, ends });
      }
    });
    const moves = [];
    for (const segs of groups.values()) {
      if (segs.length < 2) continue;
      segs.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
      let cluster = [segs[0]], end = segs[0].hi;
      const flush = () => {
        if (cluster.length < 2) return;
        orderBundle(cluster).forEach((s, idx) => moves.push({ s, off: (idx - (cluster.length - 1) / 2) * GAP }));
      };
      for (let n = 1; n < segs.length; n++) {
        const s = segs[n];
        if (s.lo < end - 0.5) { cluster.push(s); end = Math.max(end, s.hi); }
        else { flush(); cluster = [s]; end = s.hi; }
      }
      flush();
    }
    for (const { s, off } of moves) {
      const pts = paths[s.pi];
      const axis = s.vertical ? "x" : "y";
      pts[s.k][axis] += off;
      pts[s.k + 1][axis] += off;
    }
  }

  /**
   * rects: [{x, y, w, h}] — every card (obstacles).
   * edges: [{id, s: {x, y, dir}, t: {x, y, dir}}] — dir is +1 for a port on a card's right
   *   side, -1 for its left; (x, y) is the port's outer tip.
   * Returns Map(edge id -> [{x, y}, ...]).
   */
  function route(rects, edges, cheap) {
    const out = new Map();
    const G = cheap ? null : buildGrid(rects, edges.flatMap((e) => [stubOf(e.s), stubOf(e.t)]));
    if (!G) {
      edges.forEach((e) => out.set(e.id, simpleRoute(e.s, e.t)));
      return out;
    }
    // Short cables first: they have the fewest options, long ones can detour.
    const order = edges.slice().sort((a, b) =>
      (Math.abs(a.s.x - a.t.x) + Math.abs(a.s.y - a.t.y)) - (Math.abs(b.s.x - b.t.x) + Math.abs(b.s.y - b.t.y)));
    const t0 = performance.now();
    const found = new Map();
    for (let pass = 0; pass <= REROUTE_PASSES; pass++) {
      for (const e of order) {
        if (performance.now() - t0 > TIME_BUDGET_MS) break;
        const old = found.get(e.id);
        if (old) commit(G, old.cells, -1);
        const r = astar(G, e.s, e.t) || old;
        if (r) { commit(G, r.cells, 1); found.set(e.id, r); }
      }
    }
    for (const e of order) out.set(e.id, found.has(e.id) ? found.get(e.id).pts : simpleRoute(e.s, e.t));
    const ids = Array.from(out.keys());
    const paths = ids.map((id) => out.get(id));
    nudge(paths);
    ids.forEach((id, i) => out.set(id, compress(paths[i])));
    return out;
  }

  window.NcjRouter = { route, STUB };
})();
