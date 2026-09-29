import django_tables2 as tables
from django.utils.translation import gettext_lazy as _
from netbox.tables import NetBoxTable, columns

from .models import TopologyLayout


class TopologyLayoutTable(NetBoxTable):
    name = tables.Column(linkify=True)
    # The diagram itself is what people come to the list for, so it gets its own link column.
    diagram = tables.TemplateColumn(
        template_code=(
            '<a href="{{ record.get_diagram_url }}" target="_blank" class="btn btn-sm btn-primary">'
            '<i class="mdi mdi-graph-outline"></i></a>'
        ),
        verbose_name=_("Diagram"),
        orderable=False,
    )
    mode = tables.Column()
    tags = columns.TagColumn(url_name="plugins:netbox_cross_journal:topologylayout_list")

    class Meta(NetBoxTable.Meta):
        model = TopologyLayout
        fields = ("pk", "id", "name", "diagram", "description", "mode", "routing", "tags", "created", "last_updated")
        default_columns = ("name", "diagram", "description", "mode", "last_updated")
