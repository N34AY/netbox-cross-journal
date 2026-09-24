/*
 * Interactive topology for netbox_cross_journal.
 *
 * Data comes from topology.py (embedded JSON). Pipeline on every filter change:
 *   filters -> visible subgraph -> ELK "layered" layout (ports on node borders, orthogonal
 *   edge routing, so nodes never overlap and edges never cross through a node) -> SVG.
 * Pan/zoom is a transform on one <g>; printing swaps that for a viewBox over the whole
 * layout so the full (filtered) diagram is scaled onto the chosen paper size.
 */
(function () {
  "use strict";

  const graph = JSON.parse(document.getElementById("topology-data").textContent);
  const T = JSON.parse(document.getElementById("topology-i18n").textContent);
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
  const FACETS = [
    { key: "device", label: T.devices, value: (n) => n.id, display: (v) => nodeById.get(v).name, open: true },
    { key: "type", label: T.device_types, value: (n) => n.type },
    { key: "role", label: T.roles, value: (n) => n.role },
    { key: "rack", label: T.racks, value: (n) => n.rack },
    { key: "location", label: T.locations, value: (n) => n.location },
    { key: "manufacturer", label: T.manufacturers, value: (n) => n.manufacturer },
  ];
  FACETS.forEach((f) => {
    const counts = new Map();
    devices.forEach((n) => { const v = f.value(n); counts.set(v, (counts.get(v) || 0) + 1); });
    f.options = Array.from(counts, ([value, count]) => ({
      value, count, label: value === "" ? T.none : (f.display ? f.display(value) : value),
    })).sort((a, b) => (a.value === "") - (b.value === "") || collator.compare(a.label, b.label));
  });

  // ---------------------------------------------------------------- state (mirrored in URL hash)
  const state = {
    kinds: new Set(KINDS),
    sel: Object.fromEntries(FACETS.map((f) => [f.key, new Set()])),
    neighbors: true,
    external: true,
    unconnected: false,
    labels: false,
  };
  function saveState() {
    const s = {
      k: KINDS.filter((k) => state.kinds.has(k)),
      n: +state.neighbors, e: +state.external, u: +state.unconnected, l: +state.labels,
    };
    FACETS.forEach((f) => { if (state.sel[f.key].size) s[f.key] = Array.from(state.sel[f.key]); });
    history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify(s)));
  }
  function loadState() {
    if (!location.hash) return;
    try {
      const s = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      if (Array.isArray(s.k)) state.kinds = new Set(s.k.filter((k) => KINDS.includes(k)));
      if ("n" in s) state.neighbors = !!s.n;
      if ("e" in s) state.external = !!s.e;
      if ("u" in s) state.unconnected = !!s.u;
      if ("l" in s) state.labels = !!s.l;
      FACETS.forEach((f) => {
        if (Array.isArray(s[f.key])) {
          const valid = new Set(f.options.map((o) => o.value));
          state.sel[f.key] = new Set(s[f.key].filter((v) => valid.has(v)));
        }
      });
    } catch (e) { /* malformed hash: keep defaults */ }
  }

  // ---------------------------------------------------------------- visible subgraph
  function computeVisible() {
    const allowed = (n) => state.external || n.in_scope;
    const anySel = FACETS.some((f) => state.sel[f.key].size);
    const focus = new Set(
      graph.nodes
        .filter((n) => allowed(n) && (!anySel || (n.kind === "device" &&
          FACETS.every((f) => !state.sel[f.key].size || state.sel[f.key].has(f.value(n))))))
        .map((n) => n.id)
    );
    const nodes = new Set(focus);
    let edges = graph.edges.filter((e) => state.kinds.has(e.kind));
    if (anySel && state.neighbors) {
      edges = edges.filter((e) => focus.has(e.source) || focus.has(e.target));
      edges.forEach((e) => {
        [e.source, e.target].forEach((id) => { if (allowed(nodeById.get(id))) nodes.add(id); });
      });
    }
    edges = edges.filter((e) => nodes.has(e.source) && nodes.has(e.target));

    const connected = new Set();
    edges.forEach((e) => { connected.add(e.source); connected.add(e.target); });
    for (const id of Array.from(nodes)) {
      // An explicitly picked device stays visible even without connections.
      if (!connected.has(id) && !state.unconnected && !state.sel.device.has(id)) nodes.delete(id);
    }
    const usedPorts = new Set();
    edges.forEach((e) => { usedPorts.add(e.source_port); usedPorts.add(e.target_port); });
    return { nodes, edges, usedPorts };
  }

  // ---------------------------------------------------------------- ELK layout
  const elk = new ELK();
  const HEADER_H = 50;
  const PORT_SIZE = 9;

  function buildElkGraph(vis) {
    const children = [];
    const labels = new Map();
    for (const n of graph.nodes) {
      if (!vis.nodes.has(n.id)) continue;
      const ports = n.ports.filter((p) => vis.usedPorts.has(p.id));
      const title = truncate(n.name, FONT_TITLE, 320);
      const sub = truncate(nodeSubtitle(n), FONT_SUB, 320);
      const minW = Math.max(170, textWidth(title, FONT_TITLE) + 34, textWidth(sub, FONT_SUB) + 34);
      labels.set(n.id, { title, sub });
      children.push({
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
      });
    }
    const edges = vis.edges.map((e) => ({
      id: e.id,
      sources: [e.source_port],
      targets: [e.target_port],
      labels: state.labels && e.label
        ? [{ text: e.label, width: textWidth(e.label, FONT_EDGE) + 10, height: 16 }] : [],
    }));
    return { labels, elkGraph: {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        // Port spacing is read from the parent graph by the layered algorithm, not from each
        // node — set on a node it's silently ignored and ports land on top of the header.
        "elk.spacing.portsSurrounding": `[top=${HEADER_H + 8},left=0,bottom=10,right=0]`,
        "elk.spacing.portPort": "9",
        "elk.spacing.labelPortHorizontal": "7",
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
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.thoroughness": "20",
        "elk.layered.edgeLabels.sideSelection": "SMART_UP",
        "elk.edgeLabels.placement": "CENTER",
        "elk.separateConnectedComponents": "true",
        "elk.spacing.componentComponent": "70",
        "elk.aspectRatio": "1.6",
        "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      },
      children,
      edges,
    } };
  }

  // ---------------------------------------------------------------- rendering
  let layout = null;          // last ELK result
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

  function render(result, vis, labels) {
    layout = result;
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

    for (const ln of result.children || []) {
      const n = nodeById.get(ln.id);
      const g = el("g", {
        class: "g-node" + (n.in_scope ? "" : " external"),
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
      el("text", { x: 14, y: 24, class: "g-node-title" }, g).textContent = labels.get(n.id).title;
      el("text", { x: 14, y: 40, class: "g-node-sub" }, g).textContent = labels.get(n.id).sub;
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
    applySelection();
  }

  // ---------------------------------------------------------------- relayout
  let layoutSeq = 0;
  let firstLayout = true;
  async function relayout(opts) {
    const seq = ++layoutSeq;
    const vis = computeVisible();
    $("busy").hidden = false;
    try {
      const { elkGraph, labels } = buildElkGraph(vis);
      const result = await elk.layout(elkGraph);
      if (seq !== layoutSeq) return; // a newer filter change superseded this one
      render(result, vis, labels);
      if (firstLayout || !(opts && opts.keepView)) fit();
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
    view.x = (r.width - layout.width * view.k) / 2;
    view.y = (r.height - layout.height * view.k) / 2;
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

  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      canvas.classList.add("panning");
      hideTooltip();
    }
    if (drag.moved) {
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      applyView();
    }
  });
  window.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    canvas.classList.remove("panning");
    if (!wasDrag) handleClick(e);
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
        h("div", { class: "sub", text: n.in_scope ? nodeSubtitle(n) : `${nodeSubtitle(n)} · ${T.outside_scope}` }),
        close,
      ]);
      const rows = [
        [T.manufacturer, n.manufacturer], [T.role, n.role], [T.status, n.status],
        [T.rack, [n.rack, n.position].filter(Boolean).join(" ")], [T.location, n.location],
      ].filter((r) => r[1]);
      const dl = h("dl", null, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));
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

  const OPTS = { neighbors: "opt-neighbors", external: "opt-external", unconnected: "opt-unconnected", labels: "opt-labels" };
  Object.entries(OPTS).forEach(([key, id]) => {
    $(id).addEventListener("change", () => { state[key] = $(id).checked; onFiltersChanged({ keepView: key === "labels" }); });
  });

  const facetEls = {};
  FACETS.forEach((f) => {
    if (f.options.length < 2 && f.key !== "device") return; // nothing to choose between
    const list = h("div", { class: "facet-list" });
    const badge = h("span", { class: "badge", hidden: "" });
    const search = h("input", { class: "facet-search", type: "search", placeholder: T.search });
    const rows = f.options.map((o) => {
      const cb = h("input", { type: "checkbox" });
      cb.checked = state.sel[f.key].has(o.value);
      cb.addEventListener("change", () => {
        cb.checked ? state.sel[f.key].add(o.value) : state.sel[f.key].delete(o.value);
        onFiltersChanged();
      });
      const row = h("label", { class: "facet-option", title: o.label }, [
        cb, h("span", { class: "name", text: o.label }), h("span", { class: "count", text: String(o.count) }),
      ]);
      row._cb = cb; row._value = o.value; row._text = o.label.toLowerCase();
      list.appendChild(row);
      return row;
    });
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach((r) => { r.hidden = !!q && !r._text.includes(q); });
    });
    const clear = h("button", { type: "button", class: "link-btn", text: T.clear, onclick: () => {
      state.sel[f.key].clear();
      syncControls();
      onFiltersChanged();
    } });
    const details = h("details", { class: "facet" }, [
      h("summary", null, [f.label, badge]),
      h("div", { class: "facet-body" }, [
        f.options.length > 7 ? search : null, list, h("div", { class: "facet-actions" }, [clear]),
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
    Object.entries(facetEls).forEach(([key, { rows }]) => rows.forEach((r) => { r._cb.checked = state.sel[key].has(r._value); }));
    renderFacetBadges();
  }
  $("reset-filters").addEventListener("click", () => {
    state.kinds = new Set(KINDS);
    FACETS.forEach((f) => state.sel[f.key].clear());
    state.neighbors = true; state.external = true; state.unconnected = false;
    syncControls();
    onFiltersChanged();
  });
  $("toggle-sidebar").addEventListener("click", () => {
    document.querySelector(".app").classList.toggle("sidebar-hidden");
    requestAnimationFrame(fit);
  });

  // ---------------------------------------------------------------- legend
  function legendItems() {
    const items = KINDS.filter((k) => kindCounts[k]).map((k) => h("span", { class: "legend-item" }, [
      h("span", { class: "legend-line", style: `border-top-color:var(${KIND_VAR[k]});border-top-style:${k === "data" ? "solid" : k === "power" ? "dashed" : "dotted"}` }),
      T[k],
    ]));
    items.push(h("span", { class: "legend-item" }, [h("span", { class: "legend-box" }), T.in_scope]));
    if (graph.nodes.some((n) => !n.in_scope)) {
      items.push(h("span", { class: "legend-item" }, [h("span", { class: "legend-box ext" }), T.outside_scope]));
    }
    return items;
  }
  legendItems().forEach((i) => $("legend").appendChild(i));
  legendItems().forEach((i) => $("print-legend").appendChild(i));

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
      parts.push(`${f.label}: ${names.join(", ")}`);
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
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
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
    clone.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    clone.setAttribute("width", layout.width);
    clone.setAttribute("height", layout.height);
    const vp = clone.querySelector("#viewport");
    vp.removeAttribute("transform");
    vp.removeAttribute("id");
    clone.querySelectorAll(".hl, .selected").forEach((x) => x.classList.remove("hl", "selected"));
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = css.join("\n");
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", "#ffffff");
    clone.insertBefore(bg, style.nextSibling);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)],
      { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `topology-${graph.scope.label}.svg`.replace(/[\\/:*?"<>|\s]+/g, "_");
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  $("export-svg").addEventListener("click", exportSvg);

  // ---------------------------------------------------------------- go
  loadState();
  syncControls();
  relayout();
})();
