from __future__ import annotations

from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.contrib.contenttypes.models import ContentType
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.translation import gettext_lazy as _
from django.views import View

from .excel import build_workbook
from .forms import CrossJournalSettingsForm
from .models import CrossJournalSettings
from .reportgen import gather_report


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
