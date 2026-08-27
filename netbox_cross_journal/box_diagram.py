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

Coloring is intentionally not a hardcoded "internet vs telephony" classifier: this instance
already tags far-end devices (e.g. "Інтернет", "ЕКМ") for other purposes, and Tag already
carries a `color`. Reusing that means the legend adapts automatically to whatever tagging
scheme is actually in use, instead of a second classification the plugin would have to be
taught about separately.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from dcim.models import Cable, Device, FrontPort, PortMapping, RearPort

_NATURAL_KEY_RE = re.compile(r"(\d+)")


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
    tag_name: str = ""
    tag_color: str = ""  # 6-hex-digit, no leading '#'


@dataclass
class PlintRow:
    rear_port_id: int
    name: str
    cells: list[PositionCell] = field(default_factory=list)


@dataclass
class LegendEntry:
    name: str
    color: str


@dataclass
class BoxDiagramData:
    device_id: int
    device_name: str
    device_type: str
    plints: list[PlintRow]
    legend: list[LegendEntry]


def _far_end(front_port: FrontPort) -> tuple[str, str, str, str]:
    """Returns (far_device_name, far_port_name, tag_name, tag_color) for whatever is on the
    other end of front_port's cable, or ("", "", "", "") if nothing resolves."""
    peers = front_port.link_peers
    if not peers:
        return "", "", "", ""
    peer = peers[0]
    peer_device = getattr(peer, "device", None)
    if peer_device is None:
        return "", peer.name, "", ""
    tag = peer_device.tags.first()
    tag_name = tag.name if tag else ""
    tag_color = tag.color if tag else ""
    return peer_device.name, peer.name, tag_name, tag_color


def gather_box_diagram(device: Device) -> BoxDiagramData:
    rear_ports = list(RearPort.objects.filter(device=device))
    rear_ports.sort(key=lambda rp: _natural_key(rp.name))

    plints: list[PlintRow] = []
    legend: dict[str, str] = {}

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
        row = PlintRow(rear_port_id=rp.pk, name=rp.name)
        for position in range(1, rp.positions + 1):
            fp = front_ports_by_position.get(position)
            if fp is None:
                row.cells.append(PositionCell(position=position, state="unbuilt"))
                continue

            description = (fp.description or "").strip()
            if fp.cable_id:
                cable = Cable.objects.get(pk=fp.cable_id)
                far_device, far_port, tag_name, tag_color = _far_end(fp)
                if tag_name:
                    legend.setdefault(tag_name, tag_color)
                row.cells.append(PositionCell(
                    position=position, state="connected",
                    front_port_id=fp.pk, front_port_name=fp.name,
                    description=description, cable_label=cable.label or f"#{cable.pk}",
                    far_device=far_device, far_port=far_port,
                    tag_name=tag_name, tag_color=tag_color,
                ))
            elif description:
                row.cells.append(PositionCell(
                    position=position, state="documented_only",
                    front_port_id=fp.pk, front_port_name=fp.name, description=description,
                ))
            else:
                row.cells.append(PositionCell(
                    position=position, state="free",
                    front_port_id=fp.pk, front_port_name=fp.name,
                ))
        plints.append(row)

    return BoxDiagramData(
        device_id=device.pk,
        device_name=device.name or f"#{device.pk}",
        device_type=str(device.device_type),
        plints=plints,
        legend=[LegendEntry(name=n, color=c) for n, c in sorted(legend.items())],
    )
