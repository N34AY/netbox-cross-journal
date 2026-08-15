from django.urls import path

from . import views

urlpatterns = (
    path("settings/", views.SettingsEditView.as_view(), name="settings"),
    path(
        "report/<int:content_type_id>/<int:object_id>/",
        views.ReportView.as_view(),
        name="report",
    ),
    path(
        "report/<int:content_type_id>/<int:object_id>/export/xlsx/",
        views.ReportExcelView.as_view(),
        name="report_export_xlsx",
    ),
)
