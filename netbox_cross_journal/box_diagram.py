"""Renders a single cross-connect box (a Device with punch-block-style RearPorts, e.g. a
KRONE/110 wall box) as a plint-by-pair grid — one row per RearPort ("plint"), one cell per
pair/position.

Why this exists instead of reusing topology.build_topology_svg(): that diagram draws one
node per *device* and one edge per *cable*. A cross-connect box with, say, 30 patched pairs
all landing on the same voice gateway produces 30 parallel edges between the same two nodes —
neato has no good layout for that (see topology.py's docstring on why neato is even used
elsewhere), the port labels overlap, and the picture answers "what's connected to what device"
when the actual question inside a box is "which pair goes where, plint by plint". A fixed
grid — the same shape a technician sees looking at the physical punch block — answers that
directly and doesn't degrade as pair count grows.

Some punch blocks have two independent IDC contacts per numbered position (side "A" — the
face with the printed number — and side "B", the unlabeled opposite face); each side can be
patched to a completely different destination. NetBox's Cable is strictly one-per-component,
so that's modeled as two separate FrontPorts sharing one pair number, named "...<label> / A"
and "...<label> / B". This module detects that suffix and groups the pair back together for
display — it does not assume anything about RearPort.positions layout (e.g. that side B
lives at position+N), so it works regardless of which position numbering a given box happens
to use, and boxes with only one side per pair (no "/ A" or "/ B" suffix at all) render
exactly as before.

A pair's own cable sometimes doesn't run straight to the final device — it lands on a
splice/distribution box first (see the "Розподільча коробка" device type), which fans a
multi-conductor cable's individual pairs out to separate final-leg cables. Those boxes are
configured (Settings → "passthrough device types") to be seen through: _resolve_endpoint()
keeps following the chain, however many such boxes are strung together, until it reaches a
device that isn't one of them. NetBox's own cable tracing can't do this alone — once a cable
has more than one termination on a side (exactly what a multi-pair trunk needs), it has no
way to say which specific pair continues through which specific output on the far box, so
each passthrough box's outgoing FrontPort instead carries an explicit "upstream_port" custom
field pointing back at the FrontPort the signal arrived from; that's the link this module
follows one hop at a time.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from dcim.models import Cable, Device, FrontPort, PortMapping, RearPort

_NATURAL_KEY_RE = re.compile(r"(\d+)")
_SIDE_SUFFIX_RE = re.compile(r"\s*/\s*([AB])$")


def _natural_key(name: str) -> tuple:
    # "Плінт 2 (тил)" must sort before "Плінт 10 (тил)" — plain string sort would put
    # "10" before "2".
    parts = _NATURAL_KEY_RE.split(name)
    return tuple(int(p) if p.isdigit() else p for p in parts)


@dataclass
class PositionCell:
    position: int
    state: str  # "connected" | "free" | "documented_only" | "unbuilt"
    front_port_id: int | None = None
    front_port_name: str = ""
    description: str = ""
    cable_label: str = ""
    far_device: str = ""
    far_port: str = ""
    via: list[str] = field(default_factory=list)  # passthrough devices the chain crossed
    side: str = ""  # "A" | "B" | "" (no A/B split on this pair)


@dataclass
class PairGroup:
    label: str  # the pair number shown on the diagram
    cells: list[PositionCell] = field(default_factory=list)  # 1 cell, or 1 per side (A/B)


@dataclass
class PlintRow:
    rear_port_id: int
    name: str
    pairs: list[PairGroup] = field(default_factory=list)


@dataclass
class BoxDiagramData:
    device_id: int
    device_name: str
    device_type: str
    plints: list[PlintRow]


def _resolve_endpoint(
    front_port: FrontPort,
    passthrough_type_ids: set[int],
    _via: list[str] | None = None,
    _visited: set[int] | None = None,
) -> tuple[str, str, list[str]]:
    """Returns (far_device_name, far_port_name, via) for whatever is ultimately on the other
    end of front_port's cable — transparently crossing any number of chained passthrough
    devices (device type id in passthrough_type_ids) instead of stopping at the first one.
    via lists the passthrough devices' names, in the order the chain crossed them.
    ("", "", via) if nothing resolves; stops (without raising) at whatever it last reached if
    a passthrough box's onward leg hasn't been documented yet, or if the chain cycles back on
    itself."""
    via = _via if _via is not None else []
    visited = _visited if _visited is not None else set()
    if front_port.pk in visited:
        return "", "", via
    visited.add(front_port.pk)

    peers = front_port.link_peers
    if not peers:
        return "", "", via
    peer = peers[0]
    peer_device = getattr(peer, "device", None)
    if peer_device is None:
        return "", peer.name, via

    if peer_device.device_type_id not in passthrough_type_ids:
        return peer_device.name, peer.name, via

    next_front_port = FrontPort.objects.filter(
        device=peer_device, custom_field_data__upstream_port=front_port.pk
    ).first()
    if next_front_port is None:
        # Documented as a passthrough box, but nobody's recorded which of its outputs
        # continues this particular pair yet — surface the box itself rather than nothing.
        return peer_device.name, peer.name, via

    return _resolve_endpoint(next_front_port, passthrough_type_ids, via + [peer_device.name], visited)


def _group_by_pair(flat_cells: list[PositionCell]) -> list[PairGroup]:
    """Groups same-pair A/B cells together by stripping a trailing " / A" or " / B" off the
    front port name — see the module docstring for why this, rather than position math, is
    the grouping key."""
    groups: dict[str, list[PositionCell]] = {}
    order: list[str] = []
    for cell in flat_cells:
        if cell.state == "unbuilt":
            key = f"__unbuilt_{cell.position}__"
        else:
            m = _SIDE_SUFFIX_RE.search(cell.front_port_name)
            if m:
                cell.side = m.group(1)
                key = cell.front_port_name[:m.start()]
            else:
                key = cell.front_port_name
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(cell)

    pair_groups = [
        PairGroup(
            label=str(min(c.position for c in groups[key])),
            cells=sorted(groups[key], key=lambda c: (c.side, c.position)),
        )
        for key in order
    ]
    pair_groups.sort(key=lambda g: int(g.label))
    return pair_groups


def gather_box_diagram(device: Device) -> BoxDiagramData:
    from .models import CrossJournalSettings

    passthrough_type_ids = set(
        CrossJournalSettings.load().passthrough_device_types.values_list("id", flat=True)
    )

    rear_ports = list(RearPort.objects.filter(device=device))
    rear_ports.sort(key=lambda rp: _natural_key(rp.name))

    plints: list[PlintRow] = []

    for rp in rear_ports:
        # NetBox 4.6+ links Front/RearPort through an explicit PortMapping row (each side has
        # its own position) rather than a rear_port/rear_port_position FK pair on FrontPort —
        # the plint's pair layout is keyed by rear_port_position, one mapping per pair.
        front_ports_by_position = {
            m.rear_port_position: m.front_port
            for m in PortMapping.objects.filter(rear_port=rp).select_related(
                "front_port", "front_port__device"
            )
        }
        flat_cells: list[PositionCell] = []
        for position in range(1, rp.positions + 1):
            fp = front_ports_by_position.get(position)
            if fp is None:
                flat_cells.append(PositionCell(position=position, state="unbuilt"))
                continue

            description = (fp.description or "").strip()
            if fp.cable_id:
                cable = Cable.objects.get(pk=fp.cable_id)
                far_device, far_port, via = _resolve_endpoint(fp, passthrough_type_ids)
                flat_cells.append(PositionCell(
                    position=position, state="connected",
                    front_port_id=fp.pk, front_port_name=fp.name,
                    description=description, cable_label=cable.label or f"#{cable.pk}",
                    far_device=far_device, far_port=far_port, via=via,
                ))
            elif description:
                flat_cells.append(PositionCell(
                    position=position, state="documented_only",
                    front_port_id=fp.pk, front_port_name=fp.name, description=description,
                ))
            else:
                flat_cells.append(PositionCell(
                    position=position, state="free",
                    front_port_id=fp.pk, front_port_name=fp.name,
                ))

        plints.append(PlintRow(rear_port_id=rp.pk, name=rp.name, pairs=_group_by_pair(flat_cells)))

    return BoxDiagramData(
        device_id=device.pk,
        device_name=device.name or f"#{device.pk}",
        device_type=str(device.device_type),
        plints=plints,
    )
