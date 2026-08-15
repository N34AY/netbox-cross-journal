from django.contrib.contenttypes.models import ContentType

from netbox.plugins import PluginTemplateExtension

SCOPE_MODELS = ("dcim.rack", "dcim.location", "dcim.site")


def _make_panel_extension(model_label):
    class CrossJournalPanel(PluginTemplateExtension):
        models = [model_label]

        def right_page(self):
            obj = self.context["object"]
            content_type = ContentType.objects.get_for_model(obj)
            return self.render("netbox_cross_journal/inc/panel.html", extra_context={
                "object_type_id": content_type.pk,
            })

    CrossJournalPanel.__name__ = f"CrossJournalPanel_{model_label.replace('.', '_')}"
    return CrossJournalPanel


template_extensions = [_make_panel_extension(model_label) for model_label in SCOPE_MODELS]
