from django.contrib.contenttypes.models import ContentType

from netbox.plugins import PluginTemplateExtension

SCOPE_MODELS = ("dcim.rack", "dcim.location", "dcim.site")
# A region can span many sites — too much for one printed journal/Excel sheet, but the
# filterable topology handles it, so regions only get the topology button.
TOPOLOGY_SCOPE_MODELS = SCOPE_MODELS + ("dcim.region",)


def _make_panel_extension(model_label, topology_only=False):
    class CrossJournalPanel(PluginTemplateExtension):
        models = [model_label]

        def right_page(self):
            obj = self.context["object"]
            content_type = ContentType.objects.get_for_model(obj)
            return self.render("netbox_cross_journal/inc/panel.html", extra_context={
                "object_type_id": content_type.pk,
                "topology_only": topology_only,
            })

    CrossJournalPanel.__name__ = f"CrossJournalPanel_{model_label.replace('.', '_')}"
    return CrossJournalPanel


class DeviceBoxDiagramPanel(PluginTemplateExtension):
    """Only surfaces on devices that actually have RearPorts (patch panels / cross-connect
    boxes) — a plain server or switch has nothing for the box diagram to draw."""

    models = ["dcim.device"]

    def right_page(self):
        device = self.context["object"]
        if not device.rearports.exists():
            return ""
        return self.render("netbox_cross_journal/inc/device_panel.html", extra_context={
            "device": device,
        })


template_extensions = [
    _make_panel_extension(model_label) for model_label in SCOPE_MODELS
] + [_make_panel_extension("dcim.region", topology_only=True), DeviceBoxDiagramPanel]
