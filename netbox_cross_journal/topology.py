"""Builds the interactive topology graph for a scope (Rack, Location, or Site) as plain JSON —
layout and rendering happen client-side with ELK.js (see static/.../topology.js).

Why port-level JSON instead of the name-keyed rows reportgen.py produces for the table/Excel:
- ELK's layered layout routes edges to *ports* on a node's border, which is what keeps port
  names readable and edges from running through nodes — so every edge here references the
  concrete component (interface/front port/power outlet...) on each end, not just a device.
- The page filters by device / type / role / rack / location / connection kind without a
  round-trip, so each node carries those facets and each edge its kind.

Devices outside the scope that a scope device is cabled to are included (in_scope=False) —
a cable leaving the rack is exactly what someone tracing a link needs to see. When that cable
lands on a pass-through port (front/rear port of a patch panel or distribution box) outside
the scope, the path is followed through the box's PortMappings to whatever sits behind it, the
same hops NetBox's cable trace shows — otherwise every box outside the scope looks like a dead
end. Cable ends that aren't on a device at all (power feeds, circuit terminations) become
their own small nodes.
"""
from __future__ import annotations

import re
from itertools import product

from dcim.models import CableTermination, Device, FrontPort, PortMapping, RearPort
from django.contrib.contenttypes.models import ContentType
from django.db.models import Q

from .models import CrossJournalSettings
from .reportgen import _devices_for_scope, _scope_kind

# termination model name -> connection kind shown/filtered in the UI
_PORT_KIND = {
    "interface": "data",
    "frontport": "data",
    "rearport": "data",
    "circuittermination": "data",
    "consoleport": "console",
    "consoleserverport": "console",
    "powerport": "power",
    "poweroutlet": "power",
    "powerfeed": "power",
}

# Safety net for pathological/looped patching; real paths are a handful of boxes deep.
_MAX_PASSTHROUGH_HOPS = 16


def _follow_passthroughs(cable_ids: set[int], scope_device_ids: list[int]) -> set[int]:
    """Extend cable_ids with the cables behind pass-through ports outside the scope.

    Only ports mapped (PortMapping) to the port the path arrived on are followed, so reaching
    one pair of a 100-pair panel outside the scope doesn't drag in the other 99.
    """
    front_ct = ContentType.objects.get_for_model(FrontPort)
    rear_ct = ContentType.objects.get_for_model(RearPort)
    expanded_front: set[int] = set()
    expanded_rear: set[int] = set()
    frontier = set(cable_ids)
    for _ in range(_MAX_PASSTHROUGH_HOPS):
        landed = (
            CableTermination.objects.filter(cable_id__in=frontier)
            .filter(Q(termination_type=front_ct) | Q(termination_type=rear_ct))
            .exclude(_device_id__in=scope_device_ids)  # scope devices' cables are all included already
            .values_list("termination_type_id", "termination_id")
        )
        fronts = {pk for ct, pk in landed if ct == front_ct.pk} - expanded_front
        rears = {pk for ct, pk in landed if ct == rear_ct.pk} - expanded_rear
        if not fronts and not rears:
            break
        expanded_front |= fronts
        expanded_rear |= rears
        peer_fronts, peer_rears = set(), set()
        for front_id, rear_id in PortMapping.objects.filter(
            Q(front_port_id__in=fronts) | Q(rear_port_id__in=rears)
        ).values_list("front_port_id", "rear_port_id"):
            if front_id in fronts:
                peer_rears.add(rear_id)
            if rear_id in rears:
                peer_fronts.add(front_id)
        new_cables = set(
            CableTermination.objects.filter(
                Q(termination_type=front_ct, termination_id__in=peer_fronts)
                | Q(termination_type=rear_ct, termination_id__in=peer_rears)
            ).values_list("cable_id", flat=True)
        ) - cable_ids
        if not new_cables:
            break
        cable_ids |= new_cables
        frontier = new_cables
    return cable_ids


def _device_node(device: Device, in_scope: bool) -> dict:
    role = device.role
    return {
        "id": f"d{device.pk}",
        "kind": "device",
        "name": device.name or f"#{device.pk}",
        "type": device.device_type.model,
        "manufacturer": device.device_type.manufacturer.name,
        "role": role.name if role else "",
        "role_color": f"#{role.color}" if role and role.color else "",
        "rack": device.rack.name if device.rack else "",
        "location": device.location.name if device.location else "",
        "site": device.site.name if device.site else "",
        "position": f"U{int(device.position)}" if device.position is not None else "",
        "status": str(device.get_status_display()),
        "in_scope": in_scope,
        "url": device.get_absolute_url(),
        "ports": [],
    }


def _object_node(obj, model: str) -> dict:
    """Node for a cable end that has no device: a power feed or a circuit termination."""
    if model == "powerfeed":
        name, sub = obj.name, str(obj.power_panel)
    else:
        name, sub = str(obj.circuit), f"{obj.circuit.provider} · {obj.term_side}"
    return {
        "id": f"o{model}{obj.pk}",
        "kind": model,
        "name": name,
        "type": sub,
        "manufacturer": "", "role": "", "role_color": "", "rack": "", "location": "",
        "site": "", "position": "", "status": "",
        "in_scope": False,
        "url": obj.get_absolute_url(),
        "ports": [],
    }


def build_topology_graph(scope) -> dict:
    settings = CrossJournalSettings.load()
    scope_devices = _devices_for_scope(scope)
    if settings.excluded_statuses:
        scope_devices = scope_devices.exclude(status__in=settings.excluded_statuses)

    nodes: dict[str, dict] = {}
    for device in scope_devices:
        nodes[f"d{device.pk}"] = _device_node(device, in_scope=True)

    scope_device_ids = [int(k[1:]) for k in nodes]
    cable_ids = set(
        CableTermination.objects.filter(_device_id__in=scope_device_ids)
        .values_list("cable_id", flat=True)
    )
    cable_ids = _follow_passthroughs(cable_ids, scope_device_ids)
    terminations = list(
        CableTermination.objects.filter(cable_id__in=cable_ids)
        .select_related("cable", "termination_type")
        .prefetch_related("termination")
        .order_by("cable_id", "cable_end", "pk")
    )

    external_ids = {
        t._device_id for t in terminations
        if t._device_id and f"d{t._device_id}" not in nodes
    }
    for device in Device.objects.filter(pk__in=external_ids).select_related(
        "device_type", "device_type__manufacturer", "role", "site", "location", "rack",
    ):
        nodes[f"d{device.pk}"] = _device_node(device, in_scope=False)

    ports: dict[str, dict] = {}
    ends: dict[int, dict[str, list[str]]] = {}
    cables = {}
    for t in terminations:
        obj = t.termination
        if obj is None:
            continue
        model = t.termination_type.model
        if t._device_id:
            node_id = f"d{t._device_id}"
        else:
            node_id = f"o{model}{obj.pk}"
            if node_id not in nodes:
                nodes[node_id] = _object_node(obj, model)
        port_id = f"{node_id}:{model}{obj.pk}"
        if port_id not in ports:
            ports[port_id] = {
                "id": port_id,
                "name": getattr(obj, "name", "") or str(obj),
                "kind": _PORT_KIND.get(model, "data"),
                "description": (getattr(obj, "description", "") or "").strip(),
            }
            nodes[node_id]["ports"].append(ports[port_id])
        ends.setdefault(t.cable_id, {"A": [], "B": []})[t.cable_end].append(port_id)
        cables[t.cable_id] = t.cable

    edges = []
    for cable_id, sides in ends.items():
        a_side, b_side = sides["A"], sides["B"]
        if not a_side or not b_side:
            continue  # half-terminated cable: nothing to draw a line to
        # Equal counts (e.g. a 4-strand bundle) pair up in order; otherwise it's a breakout
        # (1→N) and every A end fans out to every B end.
        pairs = zip(a_side, b_side) if len(a_side) == len(b_side) else product(a_side, b_side)
        cable = cables[cable_id]
        for i, (a_port, b_port) in enumerate(pairs):
            edges.append({
                "id": f"c{cable_id}-{i}",
                "cable_id": cable_id,
                "kind": ports[a_port]["kind"] if ports[a_port]["kind"] != "data" else ports[b_port]["kind"],
                "label": cable.label or "",
                "type": str(cable.get_type_display()) if cable.type else "",
                "color": f"#{cable.color}" if cable.color else "",
                "status": str(cable.get_status_display()),
                "length": f"{cable.length:g} {cable.get_length_unit_display()}" if cable.length else "",
                "url": cable.get_absolute_url(),
                "source": a_port.split(":")[0],
                "source_port": a_port,
                "target": b_port.split(":")[0],
                "target_port": b_port,
            })

    for node in nodes.values():
        node["ports"].sort(key=lambda p: (p["kind"], _natural_key(p["name"])))

    kind = _scope_kind(scope)
    return {
        "scope": {
            "label": str(scope),
            "kind": kind,
            "site": scope.name if kind == "site" else (
                scope.site.name if getattr(scope, "site", None) else ""
            ),
            "location": scope.name if kind == "location" else (
                scope.location.name if getattr(scope, "location", None) else ""
            ),
            "company": settings.company_name,
        },
        "nodes": sorted(nodes.values(), key=lambda n: (not n["in_scope"], _natural_key(n["name"]))),
        "edges": edges,
    }


def _natural_key(value: str):
    """Sort "Gi1/0/10" after "Gi1/0/9" — port and device names are full of embedded numbers."""
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", value or "")]
