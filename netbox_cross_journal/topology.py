"""Renders a ReportData scope as a network topology diagram (SVG, vector — sized correctly
at any print resolution) using Graphviz. Kept separate from excel.py/report.html so the
tabular cross-journal and the diagram can be requested independently.

Design choices, in order of what a printed cross-connect diagram needs to answer at a
glance — "what plugs into what, on which specific port":
- One node per device. Devices outside the requested scope (e.g. an uplink leaving the rack
  to a core switch elsewhere) still get a node, styled distinctly, rather than being dropped
  — a cable leaving the scope is exactly the kind of connection someone tracing a link needs
  to see, not noise to hide.
- Each edge carries the near-end and far-end port names as Graphviz taillabel/headlabel, so
  the port shows up printed right next to the device it belongs to instead of a single
  ambiguous mid-edge label.
- Power cabling renders as dashed red edges to a PDU, visually distinct from solid data
  links, so the two don't get traced as if they were the same kind of connection.
- `neato` (force-directed) rather than `dot` (hierarchical) — cross-connects are a flat mesh
  of point-to-point links, not a tree, and neato's layout keeps port labels readable instead
  of forcing everything into rank order.
"""
from __future__ import annotations

import graphviz

from .reportgen import ReportData

_IN_SCOPE_FILL = "#2C3E50"
_IN_SCOPE_FONT = "#ffffff"
_EXTERNAL_FILL = "#f8f9fa"
_EXTERNAL_FONT = "#495057"
_DATA_EDGE_COLOR = "#2C3E50"
_POWER_EDGE_COLOR = "#c0392b"


def build_topology_svg(data: ReportData) -> str:
    g = graphviz.Graph(engine="neato")
    # overlap="false" alone still lets small/sparse graphs collapse nodes into each other —
    # neato satisfies the *requested* edge length first and only pushes nodes apart afterward,
    # so a generous edge `len` matters more than `sep` for keeping the taillabel/headlabel
    # port names (which sit right next to each node) from landing on top of the node next to
    # them.
    g.attr(overlap="false", splines="true", sep="+15", fontname="sans-serif")
    g.attr("node", shape="box", style="rounded,filled", fontname="sans-serif", fontsize="11",
           margin="0.15,0.1")
    g.attr("edge", fontname="sans-serif", fontsize="8", labeldistance="2.2", labelangle="0",
           len="2.2")

    in_scope = {d.name for d in data.devices}
    external_added: set[str] = set()

    for d in data.devices:
        g.node(d.name, label=f"{d.name}\n{d.device_type}",
               fillcolor=_IN_SCOPE_FILL, fontcolor=_IN_SCOPE_FONT, color=_IN_SCOPE_FILL)

    def _ensure_external(name: str) -> None:
        if not name or name in in_scope or name in external_added:
            return
        g.node(name, label=name, style="rounded,filled,dashed",
               fillcolor=_EXTERNAL_FILL, fontcolor=_EXTERNAL_FONT, color="#adb5bd")
        external_added.add(name)

    for c in data.data_cables:
        if not c.a_device or not c.b_device:
            continue  # no second endpoint to draw an edge to (orphan/undocumented far end)
        _ensure_external(c.a_device)
        _ensure_external(c.b_device)
        g.edge(c.a_device, c.b_device,
               taillabel=c.a_port, headlabel=c.b_port,
               label=c.label, fontcolor=_DATA_EDGE_COLOR, color=_DATA_EDGE_COLOR)

    for p in data.power_cables:
        if not p.device or not p.pdu:
            continue
        _ensure_external(p.device)
        _ensure_external(p.pdu)
        g.edge(p.device, p.pdu,
               taillabel=p.port, headlabel=p.outlet,
               style="dashed", fontcolor=_POWER_EDGE_COLOR, color=_POWER_EDGE_COLOR)

    return g.pipe(format="svg").decode("utf-8")
