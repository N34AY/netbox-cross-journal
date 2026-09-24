from __future__ import annotations

from dcim.models import Device
from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.contrib.contenttypes.models import ContentType
from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.translation import gettext
from django.utils.translation import gettext_lazy as _
from django.views import View

from . import config
from .box_diagram import gather_box_diagram
from .excel import build_workbook
from .forms import CrossJournalSettingsForm
from .models import CrossJournalSettings
from .reportgen import gather_report
from .template_content import SCOPE_MODELS
from .topology import build_topology_graph


def _resolve_scope(content_type_id: int, object_id: int):
    content_type = get_object_or_404(ContentType, pk=content_type_id)
    # Content type IDs differ between databases, so a stale/bookmarked URL can point at an
    # unrelated model — 404 instead of crashing in gather_report.
    if f"{content_type.app_label}.{content_type.model}" not in SCOPE_MODELS:
        raise Http404(f"Unsupported scope type: {content_type}")
    model = content_type.model_class()
    return get_object_or_404(model, pk=object_id)


class ReportView(LoginRequiredMixin, View):
    """Print-friendly HTML preview of the cross-connect journal for one scope object."""

    template_name = "netbox_cross_journal/report.html"

    def get(self, request, content_type_id, object_id):
        scope = _resolve_scope(content_type_id, object_id)
        data = gather_report(scope)
        return render(request, self.template_name, {"data": data})


class ReportExcelView(LoginRequiredMixin, View):
    """Server-side .xlsx generation — the client only ever downloads the finished file,
    regardless of how many devices/cables the scope contains (see excel.py)."""

    def get(self, request, content_type_id, object_id):
        scope = _resolve_scope(content_type_id, object_id)
        data = gather_report(scope)
        settings = CrossJournalSettings.load()
        buf = build_workbook(data, layout=settings.excel_layout)

        filename = f"cross-journal-{data.scope_label}.xlsx".replace(" ", "_")
        response = HttpResponse(
            buf.read(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


class TopologyView(LoginRequiredMixin, View):
    """Interactive, filterable topology diagram for one scope object — a separate page from the
    tabular report, since a diagram and a table serve different reading purposes. The graph is
    embedded as JSON and laid out client-side (ELK.js), see topology.py."""

    template_name = "netbox_cross_journal/topology.html"

    def get(self, request, content_type_id, object_id):
        scope = _resolve_scope(content_type_id, object_id)
        return render(request, self.template_name, {
            "graph": build_topology_graph(scope),
            "i18n": _topology_i18n(),
            # Static URLs don't change between releases; the version busts browser caches.
            "asset_version": config.version,
        })


def _topology_i18n() -> dict:
    """Strings the topology page's JavaScript renders itself (facet names, tooltips...)."""
    return {
        "data": gettext("Data"),
        "power": gettext("Power"),
        "console": gettext("Console"),
        "devices": gettext("Devices"),
        "device_types": gettext("Device types"),
        "roles": gettext("Roles"),
        "racks": gettext("Racks"),
        "locations": gettext("Locations"),
        "sites": gettext("Sites"),
        "manufacturers": gettext("Manufacturers"),
        "tags": gettext("Tags"),
        "match_all_tags": gettext("Match all selected tags"),
        "search": gettext("Search…"),
        "none": gettext("(none)"),
        "clear": gettext("Clear"),
        "n_devices": gettext("devices"),
        "n_connections": gettext("connections"),
        "outside_scope": gettext("Outside scope"),
        "in_scope": gettext("Device in scope"),
        "open_in_netbox": gettext("Open in NetBox"),
        "focus": gettext("Show only this and neighbors"),
        "cable": gettext("Cable"),
        "type": gettext("Type"),
        "status": gettext("Status"),
        "length": gettext("Length"),
        "rack": gettext("Rack"),
        "location": gettext("Location"),
        "role": gettext("Role"),
        "manufacturer": gettext("Manufacturer"),
        "no_connections": gettext("No visible connections"),
        "power_feed": gettext("Power feed"),
        "circuit": gettext("Circuit"),
        "generated": gettext("Generated"),
        "filters": gettext("Filters"),
        "layout_failed": gettext("Layout failed"),
    }


class BoxDiagramView(LoginRequiredMixin, View):
    """Plint-by-pair grid for one cross-connect box (Device with RearPorts) — see
    box_diagram.py for why this is a fixed grid rather than the same graph the topology
    view uses."""

    template_name = "netbox_cross_journal/box_diagram.html"

    def get(self, request, device_id):
        device = get_object_or_404(Device, pk=device_id)
        data = gather_box_diagram(device)
        return render(request, self.template_name, {"data": data})


class BoxDiagramPrintView(LoginRequiredMixin, View):
    """Compact, space-minimized print layout for the same box diagram data: one small table
    per plint instead of the color-grid cards, so a fully-populated box fits on a fraction of
    a printed page instead of one page per screenful of cards."""

    template_name = "netbox_cross_journal/box_diagram_print.html"

    def get(self, request, device_id):
        device = get_object_or_404(Device, pk=device_id)
        data = gather_box_diagram(device)
        return render(request, self.template_name, {"data": data})


class SettingsEditView(LoginRequiredMixin, PermissionRequiredMixin, View):
    """Live, admin-editable plugin configuration."""

    permission_required = "netbox_cross_journal.change_crossjournalsettings"
    template_name = "netbox_cross_journal/settings.html"

    def get(self, request):
        form = CrossJournalSettingsForm(instance=CrossJournalSettings.load())
        return render(request, self.template_name, {"form": form})

    def post(self, request):
        form = CrossJournalSettingsForm(request.POST, instance=CrossJournalSettings.load())
        if form.is_valid():
            form.save()
            messages.success(request, _("Cross Journal settings saved."))
            return redirect("plugins:netbox_cross_journal:settings")
        return render(request, self.template_name, {"form": form})
