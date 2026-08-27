from __future__ import annotations

from dcim.models import Device
from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.contrib.contenttypes.models import ContentType
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.translation import gettext_lazy as _
from django.views import View

from .box_diagram import gather_box_diagram
from .excel import build_workbook
from .forms import CrossJournalSettingsForm
from .models import CrossJournalSettings
from .reportgen import gather_report
from .topology import build_topology_svg


def _resolve_scope(content_type_id: int, object_id: int):
    content_type = get_object_or_404(ContentType, pk=content_type_id)
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
    """Print-friendly SVG topology diagram for one scope object — a separate page from the
    tabular report, since a diagram and a table serve different reading purposes."""

    template_name = "netbox_cross_journal/topology.html"

    def get(self, request, content_type_id, object_id):
        scope = _resolve_scope(content_type_id, object_id)
        data = gather_report(scope)
        svg = build_topology_svg(data)
        return render(request, self.template_name, {"data": data, "svg": svg})


class BoxDiagramView(LoginRequiredMixin, View):
    """Plint-by-pair grid for one cross-connect box (Device with RearPorts) — see
    box_diagram.py for why this is a fixed grid rather than the same graph the topology
    view uses."""

    template_name = "netbox_cross_journal/box_diagram.html"

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
