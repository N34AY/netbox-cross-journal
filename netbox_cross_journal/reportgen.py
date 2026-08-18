"""
Gathers cross-connect journal data for a scope object (Rack, Location, or Site) and hands
back a plain, template/Excel-agnostic structure. Both the HTML preview view and the Excel
export view build off the same gather_report() call, so the two outputs never drift apart.

Kept dependency-free of Django's template/response layer on purpose — reportgen.py only
knows about NetBox models and this plugin's own Settings, nothing about HTML or openpyxl.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from dcim.models import Cable, Device, Location, PowerOutlet, PowerPort, Rack, Site
from django.utils.translation import gettext_lazy as _

from .models import CrossJournalSettings

# Component endpoints that can carry a Cable, in the order we walk them per device.
_CABLE_COMPONENT_ACCESSORS = (
    "interfaces",
    "frontports",
    "powerports",
    "consoleports",
)

@dataclass
class DeviceRow:
    id: int
    name: str
    device_type: str
    role: str
    serial: str
    status: str
    location: str
    primary_ip: str
    tags: list[str] = field(default_factory=list)
    comments: str = ""


@dataclass
class CableRow:
    id: int
    label: str
    cable_type: str
    a_device: str
    a_port: str
    b_device: str
    b_port: str
    comments: str = ""
    port_comment: str = ""


@dataclass
class PowerRow:
    id: int
    device: str
    port: str
    pdu: str
    outlet: str


@dataclass
class ReportData:
    scope_label: str
    scope_kind: str  # "rack" | "location" | "site"
    site_name: str
    location_name: str
    company_name: str
    devices: list[DeviceRow]
    data_cables: list[CableRow]
    power_cables: list[PowerRow]


def _device_location_label(device) -> str:
    if device.position is not None:
        return f"U{int(device.position)}"
    # Device.parent_bay is a reverse one-to-one accessor: on a device with no parent bay it
    # *raises* RelatedObjectDoesNotExist rather than returning None. That exception also
    # subclasses AttributeError specifically so getattr(..., default) works here — this
    # isn't a try/except dodge, it's the documented way to probe an optional reverse O2O.
    parent_bay = getattr(device, "parent_bay", None)
    if parent_bay is not None:
        return f"{parent_bay.device.name} / {parent_bay.name}"
    return "—"


def _devices_for_scope(scope):
    qs = Device.objects.select_related(
        "device_type", "device_type__manufacturer", "role", "site", "location", "rack",
        "primary_ip4", "parent_bay", "parent_bay__device",
    ).prefetch_related("tags")
    if isinstance(scope, Rack):
        return qs.filter(rack=scope)
    if isinstance(scope, Location):
        location_ids = [scope.pk] + list(
            scope.get_descendants().values_list("pk", flat=True)
        )
        return qs.filter(location_id__in=location_ids)
    if isinstance(scope, Site):
        return qs.filter(site=scope)
    raise TypeError(f"Unsupported scope type: {type(scope)!r}")


def _scope_kind(scope) -> str:
    if isinstance(scope, Rack):
        return "rack"
    if isinstance(scope, Location):
        return "location"
    if isinstance(scope, Site):
        return "site"
    raise TypeError(f"Unsupported scope type: {type(scope)!r}")


def _resolve_termination(endpoint) -> tuple[str, str]:
    # `Cable.a_terminations`/`b_terminations` (Django ORM property, unlike the REST API's
    # termination-wrapper shape) already return the real component instances directly —
    # Interface/FrontPort/PowerPort/etc, each with a plain `.device`/`.name`.
    device = getattr(endpoint, "device", None)
    return (device.name if device else ""), endpoint.name


def _combine_port_comments(a_description: str, b_description: str) -> str:
    # Surfaces per-port notes (e.g. "cable runs to the server room but the far end isn't
    # patched into anything yet") independently of any Cable.comments text, since that lives
    # on the ComponentModel.description field of each termination, not on the Cable itself.
    a_description = (a_description or "").strip()
    b_description = (b_description or "").strip()
    if a_description and b_description:
        return f"A: {a_description}; Б: {b_description}"
    return a_description or b_description


def gather_report(scope) -> ReportData:
    settings = CrossJournalSettings.load()
    devices = _devices_for_scope(scope)
    if settings.excluded_statuses:
        devices = devices.exclude(status__in=settings.excluded_statuses)
    devices = list(devices)

    device_rows = []
    for d in devices:
        device_rows.append(DeviceRow(
            id=d.pk,
            name=d.name or f"#{d.pk}",
            device_type=str(d.device_type),
            role=str(d.role) if d.role else "",
            serial=d.serial if settings.include_serial_numbers else "",
            status=str(d.get_status_display()),
            location=_device_location_label(d),
            primary_ip=str(d.primary_ip4) if (d.primary_ip4 and settings.include_ip_addresses) else "",
            tags=[t.name for t in d.tags.all()] if settings.include_tags else [],
            comments=(d.comments or "") if settings.include_comments else "",
        ))
    device_rows.sort(key=lambda r: (r.name))

    data_cables: list[CableRow] = []
    power_cables: list[PowerRow] = []
    seen_cable_ids: set[int] = set()

    for device in devices:
        for accessor in _CABLE_COMPONENT_ACCESSORS:
            for component in getattr(device, accessor).all():
                cable_id = component.cable_id
                if not cable_id:
                    # No Cable object — still worth a row if the port itself carries a note,
                    # e.g. a cable is physically run but its far end was never patched into
                    # anything in NetBox, so the only record of it is this description.
                    if settings.include_comments and not isinstance(component, PowerPort):
                        description = (component.description or "").strip()
                        if description:
                            data_cables.append(CableRow(
                                id=0, label="", cable_type="",
                                a_device=device.name, a_port=component.name,
                                b_device="", b_port="",
                                comments="", port_comment=description,
                            ))
                    continue
                if cable_id in seen_cable_ids:
                    continue
                seen_cable_ids.add(cable_id)
                cable = Cable.objects.get(pk=cable_id)
                a_terms = list(cable.a_terminations)
                b_terms = list(cable.b_terminations)
                a_endpoint = a_terms[0] if a_terms else None
                b_endpoint = b_terms[0] if b_terms else None
                is_power = isinstance(a_endpoint, (PowerPort, PowerOutlet)) or isinstance(
                    b_endpoint, (PowerPort, PowerOutlet)
                )
                a_dev, a_port = _resolve_termination(a_endpoint) if a_endpoint else ("", "")
                b_dev, b_port = _resolve_termination(b_endpoint) if b_endpoint else ("", "")

                if is_power and settings.include_power_cables:
                    if isinstance(a_endpoint, PowerPort):
                        power_cables.append(PowerRow(
                            id=cable.pk, device=a_dev, port=a_port, pdu=b_dev, outlet=b_port,
                        ))
                    else:
                        power_cables.append(PowerRow(
                            id=cable.pk, device=b_dev, port=b_port, pdu=a_dev, outlet=a_port,
                        ))
                elif not is_power and settings.include_data_cables:
                    port_comment = ""
                    if settings.include_comments:
                        a_desc = getattr(a_endpoint, "description", "") if a_endpoint else ""
                        b_desc = getattr(b_endpoint, "description", "") if b_endpoint else ""
                        port_comment = _combine_port_comments(a_desc, b_desc)
                    data_cables.append(CableRow(
                        id=cable.pk,
                        label=cable.label or f"#{cable.pk}",
                        cable_type=str(cable.get_type_display()) if cable.type else "",
                        a_device=a_dev, a_port=a_port, b_device=b_dev, b_port=b_port,
                        comments=(cable.comments or "") if settings.include_comments else "",
                        port_comment=port_comment,
                    ))

    data_cables.sort(key=lambda r: (r.label == "", r.label, r.a_device, r.a_port))
    power_cables.sort(key=lambda r: (r.pdu, r.outlet))

    kind = _scope_kind(scope)
    site_name = scope.name if kind == "site" else getattr(scope, "site", None) and scope.site.name or ""
    location_name = scope.name if kind == "location" else getattr(scope, "location", None) and scope.location.name or ""

    return ReportData(
        scope_label=str(scope),
        scope_kind=kind,
        site_name=site_name,
        location_name=location_name,
        company_name=settings.company_name,
        devices=device_rows,
        data_cables=data_cables,
        power_cables=power_cables,
    )
