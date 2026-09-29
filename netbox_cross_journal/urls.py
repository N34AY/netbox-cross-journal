from django.urls import include, path
from utilities.urls import get_model_urls

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
    path(
        "report/<int:content_type_id>/<int:object_id>/topology/",
        views.ScopeTopologyRedirectView.as_view(),
        name="scope_topology",
    ),
    path("topology/", views.TopologyView.as_view(), name="topology"),
    path(
        "topology-layouts/",
        include(get_model_urls("netbox_cross_journal", "topologylayout", detail=False)),
    ),
    path(
        "topology-layouts/<int:pk>/",
        include(get_model_urls("netbox_cross_journal", "topologylayout")),
    ),
    path(
        "device/<int:device_id>/box-diagram/",
        views.BoxDiagramView.as_view(),
        name="box_diagram",
    ),
    path(
        "device/<int:device_id>/box-diagram/print/",
        views.BoxDiagramPrintView.as_view(),
        name="box_diagram_print",
    ),
)
