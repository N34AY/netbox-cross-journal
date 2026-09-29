from __future__ import annotations

from dcim.models import Device, Location, Rack, Region, Site
from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.contrib.contenttypes.models import ContentType
from django.http import Http404, HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.translation import gettext
from django.utils.translation import gettext_lazy as _
from django.views import View
from netbox.object_actions import AddObject, BulkDelete, BulkExport, DeleteObject, EditObject
from netbox.views import generic
from utilities.views import register_model_view

from . import config
from .box_diagram import gather_box_diagram
from .excel import build_workbook
from .filtersets import TopologyLayoutFilterSet
from .forms import CrossJournalSettingsForm, TopologyLayoutFilterForm, TopologyLayoutForm
from .models import CrossJournalSettings, TopologyLayout
from .reportgen import _scope_kind, gather_report
from .tables import TopologyLayoutTable
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


_SCOPE_PARAMS = {"rack": Rack, "location": Location, "site": Site, "region": Region}


def _back_link(request) -> tuple[str, str]:
    """Where "back to NetBox" goes: the object a scope page linked from (?rack=12), else the
    NetBox home page."""
    for param, model in _SCOPE_PARAMS.items():
        values = request.GET.getlist(param)
        if len(values) == 1 and values[0].isdigit():
            obj = model.objects.filter(pk=values[0]).first()
            if obj:
                return obj.get_absolute_url(), str(obj)
    return reverse("home"), "NetBox"


class TopologyView(LoginRequiredMixin, View):
    """Interactive, filterable topology of everything in NetBox. Scope pages (rack, location,
    site, region) link here with that object preselected as a filter, e.g. ?rack=12, rather
    than getting a page of their own — the diagram is one filter builder. ?layout=<pk> opens a
    saved layout. The graph is embedded as JSON and laid out client-side, see topology.py."""

    template_name = "netbox_cross_journal/topology.html"

    def get(self, request):
        layout = None
        if request.GET.get("layout", "").isdigit():
            layout = TopologyLayout.objects.filter(pk=request.GET["layout"]).first()
        page = {
            "layout": {
                "id": layout.pk, "name": layout.name, "filters": layout.filters, "mode": layout.mode,
                "routing": layout.routing, "positions": layout.positions,
            } if layout else None,
            "layouts": list(TopologyLayout.objects.values("id", "name")),
            "can_add": request.user.has_perm("netbox_cross_journal.add_topologylayout"),
            "can_change": request.user.has_perm("netbox_cross_journal.change_topologylayout"),
            "api_url": reverse("plugins-api:netbox_cross_journal-api:topologylayout-list"),
            "page_url": reverse("plugins:netbox_cross_journal:topology"),
            "list_url": reverse("plugins:netbox_cross_journal:topologylayout_list"),
            "csrf_token": get_token(request),
        }
        return render(request, self.template_name, {
            "graph": build_topology_graph(),
            "back": _back_link(request),
            "page": page,
            "layout_name": layout.name if layout else "",
            "i18n": _topology_i18n(),
            # Static URLs don't change between releases; the version busts browser caches.
            "asset_version": config.version,
        })


class ScopeTopologyRedirectView(LoginRequiredMixin, View):
    """Old per-scope topology URL — kept so bookmarks land on the global diagram filtered to
    that object."""

    def get(self, request, content_type_id, object_id):
        scope = _resolve_scope(content_type_id, object_id)
        url = reverse("plugins:netbox_cross_journal:topology")
        return redirect(f"{url}?{_scope_kind(scope)}={scope.pk}")


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
        "regions": gettext("Regions"),
        "manufacturers": gettext("Manufacturers"),
        "tags": gettext("Tags"),
        "match_all_tags": gettext("Match all selected tags"),
        "search": gettext("Search…"),
        "none": gettext("(none)"),
        "clear": gettext("Clear"),
        "n_devices": gettext("devices"),
        "n_connections": gettext("connections"),
        "matching": gettext("Matches filters"),
        "neighbor": gettext("Connected neighbor"),
        "unplaced": gettext("Not placed yet"),
        "unsaved_view": gettext("Unsaved view"),
        "saving": gettext("Saving…"),
        "saved": gettext("Saved"),
        "save_failed": gettext("Could not save"),
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


#
# Saved topology layouts
#

@register_model_view(TopologyLayout, "list", path="", detail=False)
class TopologyLayoutListView(generic.ObjectListView):
    queryset = TopologyLayout.objects.all()
    table = TopologyLayoutTable
    filterset = TopologyLayoutFilterSet
    filterset_form = TopologyLayoutFilterForm
    # No import/bulk edit: filters and positions only make sense edited on the diagram.
    actions = (AddObject, BulkExport, BulkDelete)


@register_model_view(TopologyLayout)
class TopologyLayoutView(generic.ObjectView):
    queryset = TopologyLayout.objects.all()
    actions = (EditObject, DeleteObject)


@register_model_view(TopologyLayout, "add", detail=False)
@register_model_view(TopologyLayout, "edit")
class TopologyLayoutEditView(generic.ObjectEditView):
    queryset = TopologyLayout.objects.all()
    form = TopologyLayoutForm


@register_model_view(TopologyLayout, "delete")
class TopologyLayoutDeleteView(generic.ObjectDeleteView):
    queryset = TopologyLayout.objects.all()


@register_model_view(TopologyLayout, "bulk_delete", path="delete", detail=False)
class TopologyLayoutBulkDeleteView(generic.BulkDeleteView):
    queryset = TopologyLayout.objects.all()
    filterset = TopologyLayoutFilterSet
    table = TopologyLayoutTable
