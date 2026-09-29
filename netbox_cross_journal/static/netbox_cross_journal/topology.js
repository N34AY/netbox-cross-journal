/*
 * Interactive topology for netbox_cross_journal.
 *
 * Data comes from topology.py (embedded JSON: every device in NetBox). Pipeline on every
 * filter change:
 *   filters -> visible subgraph -> layout -> SVG
 * Two arrangement modes:
 *   - auto:   ELK "layered" (ports on node borders, orthogonal edge routing, so nodes never
 *             overlap and edges never cross through a node).
 *   - manual: cards sit where they were dragged. Cables are either routed around the cards
 *             by topology_router.js ("orthogonal"), or ELK's interactive mode re-lays the
 *             diagram using the dragged positions only as hints ("elk" — keeps the vertical
 *             order, snaps cards into columns).
 * Filters + arrangement can be saved as a TopologyLayout (REST API) and reopened by URL.
 * Pan/zoom is a transform on one <g>; printing swaps that for a viewBox over the whole
 * layout so the full (filtered) diagram is scaled onto the chosen paper size.
 */
(function () {
  "use strict";

  const graph = JSON.parse(document.getElementById("topology-data").textContent);
  const T = JSON.parse(document.getElementById("topology-i18n").textContent);
  const page = JSON.parse(document.getElementById("topology-page").textContent);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const KINDS = ["data", "power", "console"];
  const KIND_VAR = { data: "--edge-data", power: "--edge-power", console: "--edge-console" };

  const $ = (id) => document.getElementById(id);
  const svg = $("graph");
  const viewport = $("viewport");
  const canvas = $("canvas");

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const portById = new Map();
  graph.nodes.forEach((n) => n.ports.forEach((p) => portById.set(p.id, Object.assign({ node: n.id }, p))));

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, props, children) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "class") e.className = props[k];
      else if (k === "text") e.textContent = props[k];
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    }
    (children || []).forEach((c) => c && e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return e;
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const measureCtx = document.createElement("canvas").getContext("2d");
  const FONT_TITLE = '600 13px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const FONT_SUB = '11px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const FONT_PORT = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const FONT_EDGE = '10px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  function textWidth(text, font) {
    measureCtx.font = font;
    return Math.ceil(measureCtx.measureText(text || "").width);
  }
  function truncate(text, font, max) {
    if (textWidth(text, font) <= max) return text;
    let s = text;
    while (s.length > 1 && textWidth(s + "…", font) > max) s = s.slice(0, -1);
    return s + "…";
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function nodeSubtitle(n) {
    if (n.kind === "powerfeed") return T.power_feed + " · " + n.type;
    if (n.kind === "circuittermination") return T.circuit + " · " + n.type;
    return [n.type, [n.rack, n.position].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  }

  // ---------------------------------------------------------------- facets
  const devices = graph.nodes.filter((n) => n.kind === "device");
  const orNone = (list) => (list.length ? list : [""]);
  // Facets with a `lookup` use NetBox ids as values (names repeat: every building has a
  // "1st floor"); the lookup gives their names, tree depth and parent context, in order.
  // Multi-valued facets match if any value is selected — a location/region value list holds
  // the device's own and all ancestor ids, so a floor also matches the rooms on it.
  const FACETS = [
    { key: "device", label: T.devices, value: (n) => n.id, display: (v) => nodeById.get(v).name, open: true },
    { key: "region", label: T.regions, multi: true, value: (n) => orNone(n.region_ids), lookup: graph.regions },
    { key: "site", label: T.sites, value: (n) => n.site_id, lookup: graph.sites },
    { key: "location", label: T.locations, multi: true, value: (n) => orNone(n.location_ids), lookup: graph.locations },
    { key: "rack", label: T.racks, value: (n) => n.rack_id, lookup: graph.racks },
    { key: "type", label: T.device_types, value: (n) => n.type },
    { key: "role", label: T.roles, value: (n) => n.role },
    { key: "manufacturer", label: T.manufacturers, value: (n) => n.manufacturer },
    // A device matches if it has any selected tag (or all, with "match all").
    { key: "tag", label: T.tags, multi: true, value: (n) => orNone(n.tags.map((t) => t.name)) },
  ];
  const tagColors = new Map();
  devices.forEach((n) => n.tags.forEach((t) => tagColors.set(t.name, t.color)));
  const facetValues = (f, n) => (f.multi ? f.value(n) : [f.value(n)]);
  FACETS.forEach((f) => {
    const counts = new Map();
    devices.forEach((n) => facetValues(f, n).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1)));
    if (f.lookup) {
      f.options = f.lookup.filter((o) => counts.has(o.id)).map((o) => ({
        value: o.id, count: counts.get(o.id), label: o.name, depth: o.depth, context: o.context,
      }));
      if (counts.has("")) f.options.push({ value: "", count: counts.get(""), label: T.none, depth: 0, context: "" });
      return;
    }
    f.options = Array.from(counts, ([value, count]) => ({
      value, count, label: value === "" ? T.none : (f.display ? f.display(value) : value),
    })).sort((a, b) => (a.value === "") - (b.value === "") || collator.compare(a.label, b.label));
  });
  function facetMatches(f, n) {
    const sel = state.sel[f.key];
    if (!sel.size) return true;
    const vals = facetValues(f, n);
    if (f.key === "tag" && state.tagMatchAll) return Array.from(sel).every((v) => vals.includes(v));
    return vals.some((v) => sel.has(v));
  }

  // ---------------------------------------------------------------- state (mirrored in URL hash)
  const state = {
    kinds: new Set(KINDS),
    sel: Object.fromEntries(FACETS.map((f) => [f.key, new Set()])),
    neighbors: true,
    unconnected: false,
    labels: true,
    tagMatchAll: false,
  };
  // The same object is the URL hash and a saved layout's `filters`.
  function stateSnapshot() {
    const s = {
      k: KINDS.filter((k) => state.kinds.has(k)),
      n: +state.neighbors, u: +state.unconnected, l: +state.labels, ta: +state.tagMatchAll,
    };
    FACETS.forEach((f) => { if (state.sel[f.key].size) s[f.key] = Array.from(state.sel[f.key]); });
    return s;
  }
  function saveState() {
    history.replaceState(null, "", pageUrl() + "#" + encodeURIComponent(JSON.stringify(stateSnapshot())));
  }
  function pageUrl() {
    return page.page_url + (arr.id ? "?layout=" + arr.id : "");
  }
  function applySnapshot(s) {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.k)) state.kinds = new Set(s.k.filter((k) => KINDS.includes(k)));
    if ("n" in s) state.neighbors = !!s.n;
    if ("u" in s) state.unconnected = !!s.u;
    if ("l" in s) state.labels = !!s.l;
    if ("ta" in s) state.tagMatchAll = !!s.ta;
    FACETS.forEach((f) => {
      if (Array.isArray(s[f.key])) {
        const valid = new Set(f.options.map((o) => o.value));
        state.sel[f.key] = new Set(s[f.key].map(String).filter((v) => valid.has(v)));
      }
    });
  }
  // Precedence: saved layout < query string (?rack=12 from a rack page) < hash (this tab's
  // own unsaved edits, so a reload keeps them).
  function loadState() {
    if (page.layout) applySnapshot(page.layout.filters);
    const q = new URLSearchParams(location.search);
    const fromQuery = {};
    FACETS.forEach((f) => { if (q.has(f.key)) fromQuery[f.key] = q.getAll(f.key); });
    applySnapshot(fromQuery);
    if (location.hash) {
      try { applySnapshot(JSON.parse(decodeURIComponent(location.hash.slice(1)))); }
      catch (e) { /* malformed hash: keep what we have */ }
    }
  }

  // ---------------------------------------------------------------- visible subgraph
  // `focus` = devices matching the filters (everything, with none set). With "neighbors" on,
  // cables are followed out of the focus to the device at the other end; when that end is a
  // pass-through port (patch panel / distribution box) the walk continues through the port
  // it's mapped to, so a box outside the filter isn't a dead end.
  function computeVisible() {
    const anySel = FACETS.some((f) => state.sel[f.key].size);
    const kindEdges = graph.edges.filter((e) => state.kinds.has(e.kind));
    const focus = new Set(
      graph.nodes
        .filter((n) => !anySel || (n.kind === "device" && FACETS.every((f) => facetMatches(f, n))))
        .map((n) => n.id)
    );
    const nodes = new Set(focus);
    let edges;
    if (!anySel) edges = kindEdges;
    else if (!state.neighbors) edges = kindEdges.filter((e) => focus.has(e.source) && focus.has(e.target));
    else {
      const byPort = new Map();
      kindEdges.forEach((e) => [e.source_port, e.target_port].forEach((p) => {
        if (!byPort.has(p)) byPort.set(p, []);
        byPort.get(p).push(e);
      }));
      const picked = new Set();
      const queue = [];
      focus.forEach((id) => nodeById.get(id).ports.forEach((p) => queue.push(p.id)));
      const seen = new Set(queue);
      while (queue.length) {
        const pid = queue.pop();
        for (const e of byPort.get(pid) || []) {
          if (picked.has(e)) continue;
          picked.add(e);
          const other = portById.get(e.source_port === pid ? e.target_port : e.source_port);
          nodes.add(other.node);
          if (focus.has(other.node)) continue;
          for (const m of other.maps || []) if (!seen.has(m)) { seen.add(m); queue.push(m); }
        }
      }
      edges = kindEdges.filter((e) => picked.has(e));
    }

    const connected = new Set();
    edges.forEach((e) => { connected.add(e.source); connected.add(e.target); });
    for (const id of Array.from(nodes)) {
      // An explicitly picked device stays visible even without connections.
      if (!connected.has(id) && !state.unconnected && !state.sel.device.has(id)) nodes.delete(id);
    }
    const usedPorts = new Set();
    edges.forEach((e) => { usedPorts.add(e.source_port); usedPorts.add(e.target_port); });
    return { nodes, edges, usedPorts, focus };
  }
  const isNeighbor = (vis, n) => !vis.focus.has(n.id) || n.kind !== "device";

  // ---------------------------------------------------------------- arrangement (saved layout)
  const arr = {
    id: page.layout ? page.layout.id : null,
    name: page.layout ? page.layout.name : "",
    mode: page.layout && page.layout.mode === "manual" ? "manual" : "auto",
    routing: page.layout && page.layout.routing === "elk" ? "elk" : "orthogonal",
    // node id -> {x, y} (top-left corner of the card)
    positions: new Map(Object.entries((page.layout && page.layout.positions) || {})
      .filter(([, p]) => p && isFinite(p.x) && isFinite(p.y))),
    unplaced: new Set(), // put aside automatically (new device), not yet moved by anyone
    dirty: false,
  };
  const SNAP = 10;
  const snap = (v) => Math.round(v / SNAP) * SNAP;

  // ---------------------------------------------------------------- ELK layout
  const elk = new ELK();
  const HEADER_H = 50;
  const PORT_SIZE = 9;
  const PORT_PITCH = PORT_SIZE + 9;
  const PORTS_TOP = HEADER_H + 8;
  const LABEL_GAP = 7;

  const nodeText = new Map(); // node id -> {title, sub, minW}; text never changes, measure once
  function textOf(n) {
    if (!nodeText.has(n.id)) {
      const title = truncate(n.name, FONT_TITLE, 320);
      const sub = truncate(nodeSubtitle(n), FONT_SUB, 320);
      const minW = Math.max(170, textWidth(title, FONT_TITLE) + 34, textWidth(sub, FONT_SUB) + 34);
      nodeText.set(n.id, { title, sub, minW });
    }
    return nodeText.get(n.id);
  }
  const edgeLabelSize = (text) => ({ width: textWidth(text, FONT_EDGE) + 10, height: 16 });

  const ELK_BASE = {
    "elk.algorithm": "layered",
    // Port spacing is read from the parent graph by the layered algorithm, not from each
    // node — set on a node it's silently ignored and ports land on top of the header.
    "elk.spacing.portsSurrounding": `[top=${PORTS_TOP},left=0,bottom=10,right=0]`,
    "elk.spacing.portPort": "9",
    "elk.spacing.labelPortHorizontal": String(LABEL_GAP),
    "elk.spacing.labelPortVertical": "2",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.spacing.nodeNodeBetweenLayers": "110",
    "elk.layered.spacing.edgeNodeBetweenLayers": "22",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
    "elk.spacing.nodeNode": "40",
    "elk.spacing.edgeNode": "22",
    "elk.spacing.edgeEdge": "12",
    "elk.spacing.edgeLabel": "4",
    "elk.layered.edgeLabels.sideSelection": "SMART_UP",
    "elk.edgeLabels.placement": "CENTER",
    "elk.padding": "[top=40,left=40,bottom=40,right=40]",
  };
  const ELK_AUTO = Object.assign({}, ELK_BASE, {
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.thoroughness": "20",
    "elk.separateConnectedComponents": "true",
    "elk.spacing.componentComponent": "70",
    "elk.aspectRatio": "1.6",
  });
  // Every phase takes the cards' current coordinates as input: x decides the column (layer),
  // y the order within it. Components must stay together or ELK packs them anew.
  const ELK_INTERACTIVE = Object.assign({}, ELK_BASE, {
    "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
    "elk.layered.layering.strategy": "INTERACTIVE",
    "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
    "elk.layered.nodePlacement.strategy": "INTERACTIVE",
    "elk.separateConnectedComponents": "false",
  });

  function buildElkGraph(vis, interactive) {
    const children = [];
    for (const n of graph.nodes) {
      if (!vis.nodes.has(n.id)) continue;
      const ports = n.ports.filter((p) => vis.usedPorts.has(p.id));
      const { minW } = textOf(n);
      const child = {
        id: n.id,
        width: minW,
        height: HEADER_H + 12,
        layoutOptions: {
          "elk.portConstraints": "FREE",
          "elk.nodeSize.constraints": "PORTS PORT_LABELS MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${minW}, ${HEADER_H + 12})`,
          "elk.portLabels.placement": "INSIDE",
          // Ports straddle the border instead of sitting just outside it.
          "elk.port.borderOffset": String(-PORT_SIZE / 2),
        },
        ports: ports.map((p) => ({
          id: p.id,
          width: PORT_SIZE,
          height: PORT_SIZE,
          labels: [{ text: p.name, width: textWidth(p.name, FONT_PORT), height: 13 }],
        })),
      };
      if (interactive) Object.assign(child, arr.positions.get(n.id));
      children.push(child);
    }
    const edges = vis.edges.map((e) => ({
      id: e.id,
      sources: [e.source_port],
      targets: [e.target_port],
      labels: state.labels && e.label ? [Object.assign({ text: e.label }, edgeLabelSize(e.label))] : [],
    }));
    return { id: "root", layoutOptions: interactive ? ELK_INTERACTIVE : ELK_AUTO, children, edges };
  }

  async function elkLayout(vis, interactive) {
    const result = await elk.layout(buildElkGraph(vis, interactive));
    result.x0 = 0;
    result.y0 = 0;
    return result;
  }

  // ---------------------------------------------------------------- manual layout
  // Cards at their stored positions. Each cabled port goes on the side facing its peer
  // (right for both when the cards are stacked above each other), sorted by the peer's height
  // so cables leave a card without crossing; the card grows to fit its ports and labels.
  function manualLayout(vis, cheap) {
    const geo = new Map();
    for (const id of vis.nodes) {
      const n = nodeById.get(id);
      const pos = arr.positions.get(id);
      geo.set(id, {
        n, x: pos.x, y: pos.y, w: textOf(n).minW, h: HEADER_H + 12,
        ports: n.ports.filter((p) => vis.usedPorts.has(p.id)).map((p) => ({ p, side: "right", idx: 0, peers: [] })),
      });
    }
    const portGeo = new Map();
    geo.forEach((g) => g.ports.forEach((pg) => portGeo.set(pg.p.id, pg)));
    vis.edges.forEach((e) => {
      portGeo.get(e.source_port).peers.push(e.target_port);
      portGeo.get(e.target_port).peers.push(e.source_port);
    });
    const nodeOfPort = (pid) => geo.get(portById.get(pid).node);
    const avg = (list, f) => list.reduce((acc, v) => acc + f(v), 0) / list.length;
    const portAbsY = (g, pg) => g.y + PORTS_TOP + pg.idx * PORT_PITCH + PORT_SIZE / 2;

    geo.forEach((g) => g.ports.forEach((pg) => {
      const cx = g.x + g.w / 2;
      const peerCx = avg(pg.peers, (q) => { const o = nodeOfPort(q); return o.x + o.w / 2; });
      const peerW = avg(pg.peers, (q) => nodeOfPort(q).w);
      const overlapping = Math.abs(peerCx - cx) < (g.w + peerW) / 2 + 2 * NcjRouter.STUB;
      pg.side = overlapping || peerCx >= cx ? "right" : "left";
    }));
    // Two passes: first order by the peer card's middle, then by the peer port's own height.
    for (let pass = 0; pass < 2; pass++) {
      geo.forEach((g) => {
        ["left", "right"].forEach((side) => {
          const list = g.ports.filter((pg) => pg.side === side);
          list.forEach((pg) => {
            pg.key = avg(pg.peers, (q) => {
              const o = nodeOfPort(q);
              return pass === 0 ? o.y + o.h / 2 : portAbsY(o, portGeo.get(q));
            });
          });
          list.sort((a, b) => a.key - b.key || collator.compare(a.p.name, b.p.name));
          list.forEach((pg, i) => { pg.idx = i; });
        });
        const count = Math.max(0, ...["left", "right"].map((sd) => g.ports.filter((pg) => pg.side === sd).length));
        g.h = Math.max(HEADER_H + 12, PORTS_TOP + count * PORT_PITCH - 9 + 10);
      });
    }
    geo.forEach((g) => {
      const widest = (side) => Math.max(0, ...g.ports.filter((pg) => pg.side === side)
        .map((pg) => textWidth(pg.p.name, FONT_PORT)));
      g.w = Math.max(g.w, widest("left") + widest("right") + 2 * (PORT_SIZE / 2 + LABEL_GAP) + 28);
    });

    const endOf = (pid) => {
      const g = nodeOfPort(pid), pg = portGeo.get(pid);
      const right = pg.side === "right";
      return { x: right ? g.x + g.w + PORT_SIZE / 2 : g.x - PORT_SIZE / 2, y: portAbsY(g, pg), dir: right ? 1 : -1 };
    };
    const routes = NcjRouter.route(
      Array.from(geo.values(), (g) => ({ x: g.x, y: g.y, w: g.w, h: g.h })),
      vis.edges.map((e) => ({ id: e.id, s: endOf(e.source_port), t: endOf(e.target_port) })),
      cheap
    );

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    const children = Array.from(geo.values(), (g) => {
      grow(g.x, g.y); grow(g.x + g.w, g.y + g.h);
      return {
        id: g.n.id, x: g.x, y: g.y, width: g.w, height: g.h,
        ports: g.ports.map((pg) => {
          const labelW = textWidth(pg.p.name, FONT_PORT);
          const right = pg.side === "right";
          return {
            id: pg.p.id,
            x: right ? g.w - PORT_SIZE / 2 : -PORT_SIZE / 2,
            y: PORTS_TOP + pg.idx * PORT_PITCH,
            width: PORT_SIZE, height: PORT_SIZE,
            labels: [{ text: pg.p.name, x: right ? -LABEL_GAP - labelW : PORT_SIZE + LABEL_GAP, y: -2, width: labelW, height: 13 }],
          };
        }),
      };
    });
    const edges = vis.edges.map((e) => {
      const pts = routes.get(e.id);
      pts.forEach((p) => grow(p.x, p.y));
      const labels = [];
      if (state.labels && e.label) {
        // centred on the longest straight run
        let best = 0, at = null;
        for (let i = 1; i < pts.length; i++) {
          const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
          if (len > best) { best = len; at = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 }; }
        }
        const size = edgeLabelSize(e.label);
        if (at) labels.push(Object.assign({ text: e.label, x: at.x - size.width / 2, y: at.y - size.height / 2 }, size));
      }
      return { id: e.id, sections: [{ startPoint: pts[0], bendPoints: pts.slice(1, -1), endPoint: pts[pts.length - 1] }], labels };
    });
    if (!children.length) { minX = minY = 0; maxX = maxY = 0; }
    const PAD = 40;
    return {
      x0: minX - PAD, y0: minY - PAD, width: maxX - minX + 2 * PAD, height: maxY - minY + 2 * PAD,
      children, edges,
    };
  }

  // Visible cards without a stored position: if none of them has one, the whole view starts
  // from ELK's automatic arrangement; otherwise the newcomers are stacked in columns to the
  // right of the arranged ones and flagged, so a new device is noticed and moved into place.
  async function placeMissing(vis) {
    const missing = Array.from(vis.nodes).filter((id) => !arr.positions.has(id));
    if (!missing.length) return;
    if (missing.length === vis.nodes.size) {
      (await elkLayout(vis, false)).children.forEach((c) => arr.positions.set(c.id, { x: c.x, y: c.y }));
      return;
    }
    let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    vis.nodes.forEach((id) => {
      const p = arr.positions.get(id);
      if (!p) return;
      maxX = Math.max(maxX, p.x + textOf(nodeById.get(id)).minW + 60);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y + 120);
    });
    const colH = Math.max(600, maxY - minY);
    let x = snap(maxX + 120), y = snap(minY), colW = 0;
    for (const id of missing) {
      const n = nodeById.get(id);
      const h = HEADER_H + 20 + n.ports.filter((p) => vis.usedPorts.has(p.id)).length * PORT_PITCH;
      if (y > minY && y + h > minY + colH) { x = snap(x + colW + 80); y = snap(minY); colW = 0; }
      arr.positions.set(id, { x, y });
      arr.unplaced.add(id);
      colW = Math.max(colW, textOf(n).minW);
      y = snap(y + h + 40);
    }
  }

  // ---------------------------------------------------------------- rendering
  let layout = null;          // last layout result (ELK's shape, plus x0/y0 of its bounds)
  let lastVis = null;
  let adjacency = new Map();  // node id -> Set(edge ids)
  let visibleEdges = new Map();

  function roundedPath(pts, r) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (!d1 || !d2) { d += ` L${p1.x},${p1.y}`; continue; }
      const rr = Math.min(r, d1 / 2, d2 / 2);
      const ax = p1.x + ((p0.x - p1.x) * rr) / d1, ay = p1.y + ((p0.y - p1.y) * rr) / d1;
      const bx = p1.x + ((p2.x - p1.x) * rr) / d2, by = p1.y + ((p2.y - p1.y) * rr) / d2;
      d += ` L${ax},${ay} Q${p1.x},${p1.y} ${bx},${by}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last.x},${last.y}`;
  }

  function render(result, vis) {
    layout = result;
    lastVis = vis;
    viewport.textContent = "";
    adjacency = new Map();
    visibleEdges = new Map(vis.edges.map((e) => [e.id, e]));

    const edgeLayer = el("g", { class: "g-edges" }, viewport);
    const nodeLayer = el("g", { class: "g-nodes" }, viewport);
    const labelLayer = el("g", { class: "g-edge-labels" }, viewport);

    for (const le of result.edges || []) {
      const e = visibleEdges.get(le.id);
      const g = el("g", { class: "g-edge-group", "data-edge": le.id }, edgeLayer);
      for (const s of le.sections || []) {
        const pts = [s.startPoint].concat(s.bendPoints || [], [s.endPoint]);
        const d = roundedPath(pts, 7);
        el("path", { d, class: "g-edge " + e.kind }, g);
        el("path", { d, class: "g-edge-hit" }, g);
      }
      for (const lb of le.labels || []) {
        const lg = el("g", { class: "g-edge-group", "data-edge": le.id }, labelLayer);
        el("rect", { x: lb.x, y: lb.y, width: lb.width, height: lb.height, rx: 4, class: "g-edge-label-bg" }, lg);
        const t = el("text", { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 + 3.5, "text-anchor": "middle", class: "g-edge-label" }, lg);
        t.textContent = lb.text;
      }
      [e.source, e.target].forEach((id) => {
        if (!adjacency.has(id)) adjacency.set(id, new Set());
        adjacency.get(id).add(le.id);
      });
    }

    const manual = arr.mode === "manual";
    for (const ln of result.children || []) {
      const n = nodeById.get(ln.id);
      const g = el("g", {
        class: "g-node" + (isNeighbor(vis, n) ? " external" : "") + (manual && arr.unplaced.has(n.id) ? " unplaced" : ""),
        "data-node": n.id,
        transform: `translate(${ln.x},${ln.y})`,
      }, nodeLayer);
      el("rect", { width: ln.width, height: ln.height, rx: 9, class: "g-node-body" }, g);
      if (n.role_color) {
        // Role-colored band along the top edge, clipped to the node's rounded corners.
        const clipId = "clip-" + n.id;
        el("rect", { width: ln.width, height: ln.height, rx: 9 }, el("clipPath", { id: clipId }, g));
        el("rect", { width: ln.width, height: 5, fill: n.role_color, "clip-path": `url(#${clipId})` }, g);
      }
      el("text", { x: 14, y: 24, class: "g-node-title" }, g).textContent = textOf(n).title;
      el("text", { x: 14, y: 40, class: "g-node-sub" }, g).textContent = textOf(n).sub;
      if ((ln.ports || []).length) {
        el("line", { x1: 10, x2: ln.width - 10, y1: HEADER_H, y2: HEADER_H, class: "g-node-divider" }, g);
      }
      for (const lp of ln.ports || []) {
        const p = portById.get(lp.id);
        const pg = el("g", { transform: `translate(${lp.x},${lp.y})` }, g);
        el("rect", { width: lp.width, height: lp.height, rx: 2, class: "g-port " + p.kind }, pg);
        const lb = (lp.labels || [])[0];
        if (lb) {
          const t = el("text", { x: lb.x, y: lb.y + lb.height - 3, class: "g-port-label" }, pg);
          t.textContent = lb.text;
        }
        if (p.description) el("title", null, pg).textContent = `${p.name} — ${p.description}`;
      }
    }

    $("empty").hidden = (result.children || []).length > 0;
    const nDev = (result.children || []).length;
    $("stats").innerHTML = `<b>${nDev}</b> ${T.n_devices} · <b>${vis.edges.length}</b> ${T.n_connections}`;
    renderLegend(vis);
    applySelection();
  }

  // ---------------------------------------------------------------- relayout
  let layoutSeq = 0;
  let firstLayout = true;
  async function relayout(opts) {
    opts = opts || {};
    const seq = ++layoutSeq;
    const vis = computeVisible();
    $("busy").hidden = false;
    try {
      let result;
      if (arr.mode === "auto") {
        result = await elkLayout(vis, false);
      } else {
        await placeMissing(vis);
        if (arr.routing === "elk") {
          result = await elkLayout(vis, true);
          // ELK moved the cards (into columns); take its result as the new hints so the next
          // drag starts from where the card is drawn.
          result.children.forEach((c) => arr.positions.set(c.id, { x: c.x, y: c.y }));
        } else {
          result = manualLayout(vis, false);
        }
      }
      if (seq !== layoutSeq) return; // a newer change superseded this one
      render(result, vis);
      const keep = opts.keepView || (arr.mode === "manual" && !opts.fit);
      if (firstLayout || !keep) fit();
      firstLayout = false;
    } catch (err) {
      console.error(err);
      $("empty").hidden = false;
      $("empty").textContent = T.layout_failed + ": " + err;
    } finally {
      if (seq === layoutSeq) $("busy").hidden = true;
    }
  }
  let relayoutTimer = null;
  function onFiltersChanged(opts) {
    saveState();
    renderFacetBadges();
    markDirty();
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => relayout(opts), 120);
  }

  // ---------------------------------------------------------------- pan & zoom
  const view = { x: 0, y: 0, k: 1 };
  const MIN_K = 0.05, MAX_K = 4;
  function applyView() {
    viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    $("zoom-level").textContent = Math.round(view.k * 100) + "%";
  }
  function zoomAt(k, cx, cy) {
    k = Math.min(MAX_K, Math.max(MIN_K, k));
    const r = svg.getBoundingClientRect();
    if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
    view.x = cx - ((cx - view.x) * k) / view.k;
    view.y = cy - ((cy - view.y) * k) / view.k;
    view.k = k;
    applyView();
  }
  function fit() {
    if (!layout || !layout.width) return;
    const r = svg.getBoundingClientRect();
    const k = Math.min(r.width / layout.width, r.height / layout.height, 1.25);
    view.k = Math.max(MIN_K, k);
    view.x = (r.width - layout.width * view.k) / 2 - layout.x0 * view.k;
    view.y = (r.height - layout.height * view.k) / 2 - layout.y0 * view.k;
    applyView();
  }
  function centerOn(nodeId) {
    const ln = layout && (layout.children || []).find((c) => c.id === nodeId);
    if (!ln) return;
    const r = svg.getBoundingClientRect();
    const k = Math.max(view.k, 0.8);
    view.k = k;
    view.x = r.width / 2 - (ln.x + ln.width / 2) * k;
    view.y = r.height / 2 - (ln.y + ln.height / 2) * k;
    applyView();
  }

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels step in ~100s.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(view.k * factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Dragging the background pans; dragging a card moves it. Moving a card while in auto
  // mode switches to manual, keeping every card where ELK had put it.
  let drag = null;
  let dragFrame = 0;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const nodeEl = e.target.closest && e.target.closest("[data-node]");
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, node: nodeEl ? nodeEl.dataset.node : null };
  });
  function startNodeDrag() {
    if (arr.mode === "auto") {
      layout.children.forEach((c) => arr.positions.set(c.id, { x: c.x, y: c.y }));
      arr.mode = "manual";
      updateLayoutUi();
    }
    const c = layout.children.find((ch) => ch.id === drag.node);
    drag.orig = { x: c.x, y: c.y };
    drag.el = svg.querySelector(`[data-node="${CSS.escape(drag.node)}"]`);
    drag.el.classList.add("dragging");
    canvas.classList.add("moving");
  }
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      hideTooltip();
      if (drag.node) startNodeDrag();
      else canvas.classList.add("panning");
    }
    if (!drag.moved) return;
    if (!drag.node) {
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      applyView();
      return;
    }
    const pos = { x: snap(drag.orig.x + dx / view.k), y: snap(drag.orig.y + dy / view.k) };
    arr.positions.set(drag.node, pos);
    if (arr.routing === "elk") {
      // ELK re-lays everything on drop; until then just carry the card.
      drag.el.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    } else if (!dragFrame) {
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        if (drag && drag.node) render(manualLayout(lastVis, true), lastVis);
      });
    }
  });
  window.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove("panning", "moving");
    if (!d.moved) { handleClick(e); return; }
    if (d.node) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      arr.unplaced.delete(d.node);
      markDirty();
      relayout({ keepView: true });
    }
  });

  document.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.zoom;
    if (a === "in") zoomAt(view.k * 1.25);
    else if (a === "out") zoomAt(view.k / 1.25);
    else if (a === "reset") zoomAt(1);
    else fit();
  }));
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomAt(view.k * 1.25);
    else if (e.key === "-") zoomAt(view.k / 1.25);
    else if (e.key === "0") fit();
    else if (e.key === "1") zoomAt(1);
    else if (e.key === "Escape") { select(null); $("print-popover").hidden = true; }
    else return;
    e.preventDefault();
  });
  window.addEventListener("resize", () => { if (layout) applyView(); });

  // ---------------------------------------------------------------- hover / selection
  let selected = null; // {type: "node"|"edge", id}
  let hovered = null;

  function highlight(target) {
    svg.querySelectorAll(".hl").forEach((x) => x.classList.remove("hl"));
    if (!target) { svg.classList.remove("focus"); return; }
    const nodes = new Set();
    const edges = new Set();
    if (target.type === "node") {
      nodes.add(target.id);
      (adjacency.get(target.id) || []).forEach((eid) => {
        edges.add(eid);
        const e = visibleEdges.get(eid);
        nodes.add(e.source); nodes.add(e.target);
      });
    } else {
      const e = visibleEdges.get(target.id);
      if (!e) return;
      edges.add(e.id); nodes.add(e.source); nodes.add(e.target);
    }
    nodes.forEach((id) => svg.querySelectorAll(`[data-node="${CSS.escape(id)}"]`).forEach((x) => x.classList.add("hl")));
    edges.forEach((id) => svg.querySelectorAll(`[data-edge="${CSS.escape(id)}"]`).forEach((x) => x.classList.add("hl")));
    svg.classList.add("focus");
  }
  function applySelection() {
    svg.querySelectorAll(".g-node.selected").forEach((x) => x.classList.remove("selected"));
    if (selected && selected.type === "node") {
      if (!svg.querySelector(`[data-node="${CSS.escape(selected.id)}"]`)) { select(null); return; }
      svg.querySelector(`[data-node="${CSS.escape(selected.id)}"]`).classList.add("selected");
    }
    if (selected && selected.type === "edge" && !visibleEdges.has(selected.id)) { select(null); return; }
    highlight(hovered || selected);
    renderDetails();
  }
  function select(target) {
    selected = target;
    applySelection();
  }
  function targetOf(domTarget) {
    const n = domTarget.closest && domTarget.closest("[data-node]");
    if (n) return { type: "node", id: n.dataset.node };
    const e = domTarget.closest && domTarget.closest("[data-edge]");
    if (e) return { type: "edge", id: e.dataset.edge };
    return null;
  }
  function handleClick(e) {
    if (!svg.contains(e.target)) return;
    select(targetOf(e.target));
  }
  svg.addEventListener("dblclick", (e) => {
    const t = targetOf(e.target);
    if (t && t.type === "node" && nodeById.get(t.id).kind === "device") focusDevice(t.id);
  });
  svg.addEventListener("pointerover", (e) => {
    if (drag && drag.moved) return;
    const t = targetOf(e.target);
    hovered = t;
    highlight(t || selected);
    if (t && t.type === "edge") showEdgeTooltip(t.id, e);
    else hideTooltip();
  });
  svg.addEventListener("pointermove", (e) => {
    if (hovered && hovered.type === "edge" && !(drag && drag.moved)) positionTooltip(e);
  });
  svg.addEventListener("pointerleave", () => { hovered = null; highlight(selected); hideTooltip(); });

  function endLabel(portId) {
    const p = portById.get(portId);
    return { node: nodeById.get(p.node), port: p };
  }
  function showEdgeTooltip(edgeId, ev) {
    const e = visibleEdges.get(edgeId);
    if (!e) return;
    const a = endLabel(e.source_port), b = endLabel(e.target_port);
    const tt = $("tooltip");
    tt.textContent = "";
    tt.appendChild(h("div", { class: "tt-title", text: `${T.cable} ${e.label || "#" + e.cable_id}` }));
    const meta = [e.type, e.length, e.status].filter(Boolean).join(" · ");
    if (meta) tt.appendChild(h("div", { class: "tt-row", text: meta }));
    tt.appendChild(h("div", { class: "tt-ends", text: `${a.node.name} : ${a.port.name}` }));
    tt.appendChild(h("div", { text: `↔ ${b.node.name} : ${b.port.name}` }));
    tt.hidden = false;
    positionTooltip(ev);
  }
  function positionTooltip(ev) {
    const tt = $("tooltip");
    const r = canvas.getBoundingClientRect();
    let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    if (x + tt.offsetWidth > r.width - 8) x = ev.clientX - r.left - tt.offsetWidth - 14;
    if (y + tt.offsetHeight > r.height - 8) y = ev.clientY - r.top - tt.offsetHeight - 14;
    tt.style.left = x + "px";
    tt.style.top = y + "px";
  }
  function hideTooltip() { $("tooltip").hidden = true; }

  // ---------------------------------------------------------------- details panel
  function renderDetails() {
    const box = $("details");
    box.textContent = "";
    if (!selected) { box.hidden = true; return; }
    box.hidden = false;
    const close = h("button", { class: "details-close", type: "button", title: "Esc", onclick: () => select(null) }, ["×"]);
    if (selected.type === "node") {
      const n = nodeById.get(selected.id);
      const head = h("div", { class: "details-head" }, [
        n.role_color ? h("span", { class: "accent", style: `background:${n.role_color}` }) : null,
        h("h2", { text: n.name }),
        h("div", { class: "sub", text: isNeighbor(lastVis, n) && n.kind === "device" ? `${nodeSubtitle(n)} · ${T.neighbor}` : nodeSubtitle(n) }),
        close,
      ]);
      const rows = [
        [T.manufacturer, n.manufacturer], [T.role, n.role], [T.status, n.status],
        [T.rack, [n.rack, n.position].filter(Boolean).join(" ")], [T.location, n.location],
      ].filter((r) => r[1]);
      const dl = h("dl", null, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));
      if (n.tags.length) {
        dl.appendChild(h("dt", { text: T.tags }));
        dl.appendChild(h("dd", { class: "tag-chips" }, n.tags.map((t) =>
          h("span", { class: "tag-chip" }, [h("span", { class: "tag-dot", style: `background:${t.color}` }), t.name]))));
      }
      const conns = h("div", { class: "details-conns" }, [h("h3", { text: T.n_connections })]);
      const edgeIds = Array.from(adjacency.get(n.id) || []);
      const items = edgeIds.map((id) => {
        const e = visibleEdges.get(id);
        const mine = e.source === n.id ? e.source_port : e.target_port;
        const other = e.source === n.id ? e.target_port : e.source_port;
        return { e, mine: portById.get(mine), other: endLabel(other) };
      }).sort((x, y) => collator.compare(x.mine.name, y.mine.name));
      if (!items.length) conns.appendChild(h("div", { class: "sub", text: T.no_connections }));
      items.forEach(({ e, mine, other }) => {
        conns.appendChild(h("div", { class: "conn" }, [
          h("span", { class: "dot", style: `background:var(${KIND_VAR[e.kind]})` }),
          h("span", { class: "port", text: mine.name }),
          h("span", { class: "peer" }, [
            "→ ",
            h("a", { href: "#", text: other.node.name, onclick: (ev) => { ev.preventDefault(); select({ type: "node", id: other.node.id }); centerOn(other.node.id); } }),
            ` : ${other.port.name}` + (e.label ? ` · ${e.label}` : ""),
          ]),
        ]));
      });
      const actions = h("div", { class: "details-actions" }, [
        n.kind === "device" ? h("button", { class: "btn", type: "button", text: T.focus, onclick: () => focusDevice(n.id) }) : null,
        h("a", { class: "btn btn-primary", href: n.url, target: "_blank", rel: "noopener", text: T.open_in_netbox }),
      ]);
      [head, dl, conns, actions].forEach((x) => box.appendChild(x));
    } else {
      const e = visibleEdges.get(selected.id);
      const a = endLabel(e.source_port), b = endLabel(e.target_port);
      box.appendChild(h("div", { class: "details-head" }, [
        h("span", { class: "accent", style: `background:var(${KIND_VAR[e.kind]})` }),
        h("h2", { text: `${T.cable} ${e.label || "#" + e.cable_id}` }),
        h("div", { class: "sub", text: T[e.kind] }),
        close,
      ]));
      const rows = [[T.type, e.type], [T.length, e.length], [T.status, e.status],
        ["A", `${a.node.name} : ${a.port.name}`], ["B", `${b.node.name} : ${b.port.name}`]].filter((r) => r[1]);
      box.appendChild(h("dl", null, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])));
      box.appendChild(h("div", { class: "details-actions" }, [
        h("a", { class: "btn btn-primary", href: e.url, target: "_blank", rel: "noopener", text: T.open_in_netbox }),
      ]));
    }
  }

  function focusDevice(id) {
    FACETS.forEach((f) => state.sel[f.key].clear());
    state.sel.device.add(id);
    state.neighbors = true;
    syncControls();
    selected = { type: "node", id };
    onFiltersChanged();
  }

  // ---------------------------------------------------------------- sidebar controls
  const kindCounts = Object.fromEntries(KINDS.map((k) => [k, graph.edges.filter((e) => e.kind === k).length]));
  const kindButtons = {};
  KINDS.forEach((k) => {
    const b = h("button", { type: "button", class: "kind-toggle" }, [
      h("span", { class: "swatch", style: `border-top-color:var(${KIND_VAR[k]});${k !== "data" ? "border-top-style:" + (k === "power" ? "dashed" : "dotted") : ""}` }),
      T[k],
      h("span", { class: "count", text: String(kindCounts[k]) }),
    ]);
    b.disabled = !kindCounts[k];
    b.addEventListener("click", () => {
      state.kinds.has(k) ? state.kinds.delete(k) : state.kinds.add(k);
      syncControls();
      onFiltersChanged();
    });
    kindButtons[k] = b;
    $("kind-toggles").appendChild(b);
  });

  const OPTS = { neighbors: "opt-neighbors", unconnected: "opt-unconnected", labels: "opt-labels" };
  Object.entries(OPTS).forEach(([key, id]) => {
    $(id).addEventListener("change", () => { state[key] = $(id).checked; onFiltersChanged({ keepView: key === "labels" }); });
  });

  const facetEls = {};
  FACETS.forEach((f) => {
    // nothing to choose between — unless a link (?region=..) preselected it
    if (f.options.length < 2 && f.key !== "device" && !state.sel[f.key].size) return;
    const list = h("div", { class: "facet-list" });
    const badge = h("span", { class: "badge", hidden: "" });
    const search = h("input", { class: "facet-search", type: "search", placeholder: T.search });
    let lastContext = null;
    const headers = [];
    const rows = f.options.map((o) => {
      // Racks and locations are grouped under their site.
      if (o.context && o.context !== lastContext) {
        const head = h("div", { class: "facet-group", text: o.context });
        headers.push(head);
        list.appendChild(head);
      }
      lastContext = o.context;
      const cb = h("input", { type: "checkbox" });
      cb.checked = state.sel[f.key].has(o.value);
      cb.addEventListener("change", () => {
        cb.checked ? state.sel[f.key].add(o.value) : state.sel[f.key].delete(o.value);
        onFiltersChanged();
      });
      const row = h("label", { class: "facet-option", title: o.context ? `${o.context} › ${o.label}` : o.label }, [
        cb,
        f.key === "tag" && o.value ? h("span", { class: "tag-dot", style: `background:${tagColors.get(o.value)}` }) : null,
        h("span", { class: "name", text: o.label }), h("span", { class: "count", text: String(o.count) }),
      ]);
      if (o.depth) row.style.paddingLeft = 6 + o.depth * 14 + "px";
      row._cb = cb; row._value = o.value; row._text = (o.label + " " + (o.context || "")).toLowerCase();
      list.appendChild(row);
      return row;
    });
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach((r) => { r.hidden = !!q && !r._text.includes(q); });
      headers.forEach((hd) => { hd.hidden = !!q; });
    });
    const clear = h("button", { type: "button", class: "link-btn", text: T.clear, onclick: () => {
      state.sel[f.key].clear();
      syncControls();
      onFiltersChanged();
    } });
    let matchAll = null;
    if (f.multi) {
      const input = h("input", { type: "checkbox", id: "opt-tag-all" });
      input.addEventListener("change", () => { state.tagMatchAll = input.checked; onFiltersChanged(); });
      matchAll = h("label", { class: "switch switch-sm" }, [input, h("span"), T.match_all_tags]);
    }
    const details = h("details", { class: "facet" }, [
      h("summary", null, [f.label, badge]),
      h("div", { class: "facet-body" }, [
        f.options.length > 7 ? search : null, list, matchAll,
        h("div", { class: "facet-actions" }, [clear]),
      ]),
    ]);
    if (f.open || state.sel[f.key].size) details.open = true;
    facetEls[f.key] = { rows, badge };
    $("facets").appendChild(details);
  });

  function renderFacetBadges() {
    Object.entries(facetEls).forEach(([key, { badge }]) => {
      const n = state.sel[key].size;
      badge.hidden = !n;
      badge.textContent = String(n);
    });
  }
  function syncControls() {
    KINDS.forEach((k) => kindButtons[k].setAttribute("aria-pressed", String(state.kinds.has(k))));
    Object.entries(OPTS).forEach(([key, id]) => { $(id).checked = state[key]; });
    if ($("opt-tag-all")) $("opt-tag-all").checked = state.tagMatchAll;
    Object.entries(facetEls).forEach(([key, { rows }]) => rows.forEach((r) => { r._cb.checked = state.sel[key].has(r._value); }));
    renderFacetBadges();
  }
  $("reset-filters").addEventListener("click", () => {
    state.kinds = new Set(KINDS);
    FACETS.forEach((f) => state.sel[f.key].clear());
    state.neighbors = true; state.unconnected = false; state.tagMatchAll = false;
    syncControls();
    onFiltersChanged();
  });
  $("toggle-sidebar").addEventListener("click", () => {
    document.querySelector(".app").classList.toggle("sidebar-hidden");
    requestAnimationFrame(fit);
  });

  // ---------------------------------------------------------------- legend
  function legendItems(vis) {
    const items = KINDS.filter((k) => kindCounts[k]).map((k) => h("span", { class: "legend-item" }, [
      h("span", { class: "legend-line", style: `border-top-color:var(${KIND_VAR[k]});border-top-style:${k === "data" ? "solid" : k === "power" ? "dashed" : "dotted"}` }),
      T[k],
    ]));
    items.push(h("span", { class: "legend-item" }, [h("span", { class: "legend-box" }), T.matching]));
    if (Array.from(vis.nodes).some((id) => isNeighbor(vis, nodeById.get(id)))) {
      items.push(h("span", { class: "legend-item" }, [h("span", { class: "legend-box ext" }), T.neighbor]));
    }
    if (arr.mode === "manual" && Array.from(vis.nodes).some((id) => arr.unplaced.has(id))) {
      items.push(h("span", { class: "legend-item" }, [h("span", { class: "legend-box unplaced" }), T.unplaced]));
    }
    return items;
  }
  function renderLegend(vis) {
    ["legend", "print-legend"].forEach((id) => {
      $(id).textContent = "";
      legendItems(vis).forEach((i) => $(id).appendChild(i));
    });
  }

  // ---------------------------------------------------------------- print
  const PAPER_MM = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };
  const PRINT_MARGIN_MM = 8;
  const PRINT_HEADER_MM = 21;
  let savedTheme = null;

  function filterSummary() {
    const parts = [];
    FACETS.forEach((f) => {
      if (!state.sel[f.key].size) return;
      const names = f.options.filter((o) => state.sel[f.key].has(o.value)).map((o) => o.label);
      parts.push(`${f.label}: ${names.join(f.key === "tag" && state.tagMatchAll ? " + " : ", ")}`);
    });
    if (state.kinds.size < KINDS.length) parts.push(KINDS.filter((k) => state.kinds.has(k)).map((k) => T[k]).join(" + "));
    return parts.join(" · ");
  }
  function preparePrint() {
    if (!layout) return;
    const paper = $("print-paper").value;
    const landscape = $("print-orientation").value === "landscape";
    const withHeader = $("print-header").checked;
    let [w, hgt] = PAPER_MM[paper];
    if (landscape) [w, hgt] = [hgt, w];
    $("print-page-style").textContent = `@page { size: ${w}mm ${hgt}mm; margin: ${PRINT_MARGIN_MM}mm; }`;
    // A touch under the printable height so the browser never spills onto a second page.
    const graphH = hgt - 2 * PRINT_MARGIN_MM - (withHeader ? PRINT_HEADER_MM : 0) - 3;
    document.documentElement.style.setProperty("--print-graph-h", graphH + "mm");
    document.body.classList.toggle("print-with-header", withHeader);
    const summary = filterSummary();
    $("print-meta").textContent = `${T.generated}: ${new Date().toLocaleString()} · ${$("stats").textContent}` +
      (summary ? ` · ${T.filters}: ${summary}` : "");

    savedTheme = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", "light");
    svg.setAttribute("viewBox", `${layout.x0} ${layout.y0} ${layout.width} ${layout.height}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    viewport.removeAttribute("transform");
    svg.classList.remove("focus");
  }
  function restoreAfterPrint() {
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
    savedTheme = null;
    svg.removeAttribute("viewBox");
    svg.removeAttribute("preserveAspectRatio");
    applyView();
    highlight(hovered || selected);
  }
  window.addEventListener("beforeprint", preparePrint);
  window.addEventListener("afterprint", restoreAfterPrint);

  $("print-open").addEventListener("click", (e) => {
    e.stopPropagation();
    $("print-popover").hidden = !$("print-popover").hidden;
  });
  $("print-popover").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { $("print-popover").hidden = true; });
  $("print-go").addEventListener("click", () => {
    $("print-popover").hidden = true;
    try { localStorage.setItem("ncj-topology-print", JSON.stringify({
      paper: $("print-paper").value, orientation: $("print-orientation").value, header: $("print-header").checked,
    })); } catch (e) { /* storage unavailable: settings just aren't remembered */ }
    window.print();
  });
  try {
    const p = JSON.parse(localStorage.getItem("ncj-topology-print") || "null");
    if (p) {
      if (PAPER_MM[p.paper]) $("print-paper").value = p.paper;
      if (p.orientation === "portrait" || p.orientation === "landscape") $("print-orientation").value = p.orientation;
      $("print-header").checked = p.header !== false;
    }
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- SVG export
  function exportSvg() {
    if (!layout) return;
    const prevTheme = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", "light");
    const vars = {};
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of Array.from(rules)) {
        if (r.selectorText === ":root") {
          for (const name of Array.from(r.style)) if (name.startsWith("--")) vars[name] = cssVar(name);
        }
      }
    }
    const css = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of Array.from(rules)) {
        if (r.selectorText && /^\.g-/.test(r.selectorText)) {
          css.push(r.cssText.replace(/var\((--[\w-]+)\)/g, (_, v) => vars[v] || cssVar(v)));
        }
      }
    }
    document.documentElement.setAttribute("data-theme", prevTheme);

    const clone = svg.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("class");
    clone.setAttribute("viewBox", `${layout.x0} ${layout.y0} ${layout.width} ${layout.height}`);
    clone.setAttribute("width", layout.width);
    clone.setAttribute("height", layout.height);
    const vp = clone.querySelector("#viewport");
    vp.removeAttribute("transform");
    vp.removeAttribute("id");
    clone.querySelectorAll(".hl, .selected, .unplaced").forEach((x) => x.classList.remove("hl", "selected", "unplaced"));
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = css.join("\n");
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", layout.x0); bg.setAttribute("y", layout.y0);
    bg.setAttribute("width", layout.width); bg.setAttribute("height", layout.height); bg.setAttribute("fill", "#ffffff");
    clone.insertBefore(bg, style.nextSibling);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)],
      { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `topology-${arr.name || "netbox"}.svg`.replace(/[\\/:*?"<>|\s]+/g, "_");
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  $("export-svg").addEventListener("click", exportSvg);

  // ---------------------------------------------------------------- saved layouts
  function markDirty() {
    if (arr.dirty) return;
    arr.dirty = true;
    updateLayoutUi();
  }
  function setStatus(text, isError) {
    const st = $("layout-status");
    st.textContent = text || "";
    st.classList.toggle("error", !!isError);
  }
  function updateLayoutUi() {
    $("layout-title").textContent = arr.name || T.unsaved_view;
    $("layout-title").classList.toggle("dirty", !!arr.id && arr.dirty);
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === arr.mode)));
    $("manual-opts").hidden = arr.mode !== "manual";
    $("routing-select").value = arr.routing;
    $("layout-save").hidden = !(arr.id && page.can_change);
    $("layout-save").disabled = !arr.dirty;
    $("layout-save-as").hidden = !page.can_add;
  }

  const layoutSelect = $("layout-select");
  layoutSelect.appendChild(h("option", { value: "", text: T.unsaved_view }));
  page.layouts.forEach((l) => layoutSelect.appendChild(h("option", { value: String(l.id), text: l.name })));
  layoutSelect.value = arr.id ? String(arr.id) : "";
  layoutSelect.addEventListener("change", () => {
    // A saved layout opens with its own filters; leaving one keeps the current filters.
    location.href = layoutSelect.value ? `${page.page_url}?layout=${layoutSelect.value}` : page.page_url + location.hash;
  });

  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    const mode = b.dataset.mode;
    if (mode === arr.mode) return;
    if (mode === "manual" && layout && arr.mode === "auto") {
      // Start from the arrangement on screen for cards that were never placed by hand.
      layout.children.forEach((c) => { if (!arr.positions.has(c.id)) arr.positions.set(c.id, { x: c.x, y: c.y }); });
    }
    arr.mode = mode;
    markDirty();
    updateLayoutUi();
    relayout({ fit: true });
  }));
  $("routing-select").addEventListener("change", () => {
    arr.routing = $("routing-select").value;
    markDirty();
    relayout({ keepView: true });
  });
  $("reset-arrangement").addEventListener("click", async () => {
    arr.positions.clear();
    arr.unplaced.clear();
    markDirty();
    relayout({ fit: true });
  });

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRFToken": page.csrf_token },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data.detail || Object.entries(data).map(([k, v]) => `${k}: ${[].concat(v).join(" ")}`).join("; ");
      throw new Error(msg || `HTTP ${r.status}`);
    }
    return data;
  }
  function payload() {
    const positions = {};
    if (arr.mode === "manual") {
      arr.positions.forEach((p, id) => { positions[id] = { x: Math.round(p.x), y: Math.round(p.y) }; });
    }
    return { filters: stateSnapshot(), mode: arr.mode, routing: arr.routing, positions };
  }
  $("layout-save").addEventListener("click", async () => {
    setStatus(T.saving);
    try {
      await api("PATCH", `${page.api_url}${arr.id}/`, payload());
      arr.dirty = false;
      arr.unplaced.clear();
      svg.querySelectorAll(".g-node.unplaced").forEach((x) => x.classList.remove("unplaced"));
      if (lastVis) renderLegend(lastVis);
      updateLayoutUi();
      setStatus(T.saved);
    } catch (err) {
      setStatus(`${T.save_failed}: ${err.message}`, true);
    }
  });
  $("layout-save-as").addEventListener("click", () => {
    $("save-as-form").hidden = false;
    $("save-as-name").value = arr.name ? `${arr.name} (2)` : "";
    $("save-as-name").focus();
    $("save-as-name").select();
  });
  $("save-as-cancel").addEventListener("click", () => { $("save-as-form").hidden = true; });
  $("save-as-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("save-as-name").value.trim();
    if (!name) return;
    setStatus(T.saving);
    try {
      const created = await api("POST", page.api_url, Object.assign({ name }, payload()));
      // Reopen through its own URL so the address bar is shareable right away.
      location.href = `${page.page_url}?layout=${created.id}`;
    } catch (err) {
      setStatus(`${T.save_failed}: ${err.message}`, true);
    }
  });

  // ---------------------------------------------------------------- go
  loadState();
  saveState();
  syncControls();
  updateLayoutUi();
  relayout();
})();
