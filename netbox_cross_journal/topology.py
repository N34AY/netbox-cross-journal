"""Builds the interactive topology graph — every device in NetBox — as plain JSON; layout,
filtering and rendering happen client-side with ELK.js (see static/.../topology.js).

Why port-level JSON instead of the name-keyed rows reportgen.py produces for the table/Excel:
- ELK's layered layout routes edges to *ports* on a node's border, which is what keeps port
  names readable and edges from running through nodes — so every edge here references the
  concrete component (interface/front port/power outlet...) on each end, not just a device.
- The page filters by region / site / location / rack / type / role / tag / connection kind
  without a round-trip, so each node carries those facets (with the full location and region
  ancestry, so picking a floor also matches the rooms on it) and each edge its kind.

A rack or site page doesn't get a diagram of its own: it opens this one with that object
preselected as a filter. Showing a filtered device's neighbors is also done client-side, and
it follows paths through pass-through ports (front/rear ports of patch panels and
distribution boxes) using the PortMapping pairs each such port carries in "maps" — the same
hops NetBox's cable trace shows — so a box outside the filter isn't a dead end. Cable ends
that aren't on a device at all (power feeds, circuit terminations) become their own nodes.
"""
from __future__ import annotations

import re
from itertools import product

from dcim.models import CableTermination, Device, Location, PortMapping, Rack, Region, Site

from .models import CrossJournalSettings

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

def _device_node(device: Device, location_paths: dict, region_paths: dict) -> dict:
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
        # Facet values are ids (names aren't unique: every building has a "1st floor");
        # locations/regions list their ancestors too, so a parent matches its children.
        "site_id": str(device.site_id) if device.site_id else "",
        "rack_id": str(device.rack_id) if device.rack_id else "",
        "location_ids": location_paths.get(device.location_id, []),
        "region_ids": region_paths.get(device.site.region_id, []) if device.site else [],
        "position": f"U{int(device.position)}" if device.position is not None else "",
        "status": str(device.get_status_display()),
        "tags": [{"name": t.name, "color": f"#{t.color}"} for t in device.tags.all()],
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
        "site": "", "site_id": "", "rack_id": "", "location_ids": [], "region_ids": [],
        "position": "", "status": "", "tags": [],
        "url": obj.get_absolute_url(),
        "ports": [],
    }


def _tree(model) -> tuple[list[dict], dict[int, list[str]]]:
    """(facet options in tree order, id -> [own id and every ancestor's id]) for an MPTT model."""
    rows = list(model.objects.order_by("tree_id", "lft").values(
        "pk", "name", "parent_id", "level", *(["site__name"] if model is Location else [])
    ))
    parent = {r["pk"]: r["parent_id"] for r in rows}
    paths = {}
    for r in rows:
        chain, cur = [], r["pk"]
        while cur is not None:
            chain.append(str(cur))
            cur = parent.get(cur)
        paths[r["pk"]] = chain
    options = [{
        "id": str(r["pk"]), "name": r["name"], "depth": r["level"],
        "context": r.get("site__name", ""),
    } for r in rows]
    if model is Location:
        # Group each site's location tree together; tree_ids interleave sites arbitrarily.
        options.sort(key=lambda o: _natural_key(o["context"]))
    return options, paths


def build_topology_graph() -> dict:
    settings = CrossJournalSettings.load()
    devices = Device.objects.select_related(
        "device_type", "device_type__manufacturer", "role", "site", "location", "rack",
    ).prefetch_related("tags")
    if settings.excluded_statuses:
        devices = devices.exclude(status__in=settings.excluded_statuses)

    locations, location_paths = _tree(Location)
    regions, region_paths = _tree(Region)
    nodes: dict[str, dict] = {}
    for device in devices:
        nodes[f"d{device.pk}"] = _device_node(device, location_paths, region_paths)

    terminations = list(
        CableTermination.objects
        .select_related("cable", "termination_type")
        .prefetch_related("termination")
        .order_by("cable_id", "cable_end", "pk")
    )

    ports: dict[str, dict] = {}
    passthrough: dict[tuple[str, int], str] = {}  # (model, pk) -> port id, for PortMapping
    ends: dict[int, dict[str, list[str]]] = {}
    cables = {}
    for t in terminations:
        obj = t.termination
        if obj is None:
            continue
        model = t.termination_type.model
        if t._device_id:
            node_id = f"d{t._device_id}"
            if node_id not in nodes:
                continue  # device left out by status (Settings → excluded statuses)
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
            if model in ("frontport", "rearport"):
                passthrough[(model, obj.pk)] = port_id
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

    # Front<->rear pairs inside a patch panel/box, between ports that are both cabled.
    fronts = [pk for model, pk in passthrough if model == "frontport"]
    rears = [pk for model, pk in passthrough if model == "rearport"]
    for front_id, rear_id in PortMapping.objects.filter(
        front_port_id__in=fronts, rear_port_id__in=rears
    ).values_list("front_port_id", "rear_port_id"):
        front, rear = ports[passthrough[("frontport", front_id)]], ports[passthrough[("rearport", rear_id)]]
        front.setdefault("maps", []).append(rear["id"])
        rear.setdefault("maps", []).append(front["id"])

    for node in nodes.values():
        node["ports"].sort(key=lambda p: (p["kind"], _natural_key(p["name"])))

    return {
        "company": settings.company_name,
        "regions": regions,
        "sites": [{"id": str(pk), "name": name, "depth": 0, "context": ""}
                  for pk, name in Site.objects.order_by("name").values_list("pk", "name")],
        "locations": locations,
        "racks": [{"id": str(pk), "name": name, "depth": 0, "context": site}
                  for pk, name, site in Rack.objects.order_by("site__name", "name")
                  .values_list("pk", "name", "site__name")],
        "nodes": sorted(nodes.values(), key=lambda n: (n["kind"] != "device", _natural_key(n["name"]))),
        "edges": edges,
    }


def _natural_key(value: str):
    """Sort "Gi1/0/10" after "Gi1/0/9" — port and device names are full of embedded numbers."""
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", value or "")]
