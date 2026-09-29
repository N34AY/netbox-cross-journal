from netbox.api.serializers import NetBoxModelSerializer
from rest_framework import serializers

from ..models import TopologyLayout


class TopologyLayoutSerializer(NetBoxModelSerializer):
    url = serializers.HyperlinkedIdentityField(
        view_name="plugins-api:netbox_cross_journal-api:topologylayout-detail"
    )

    class Meta:
        model = TopologyLayout
        fields = (
            "id", "url", "display", "name", "description", "filters", "mode", "routing",
            "positions", "tags", "custom_fields", "created", "last_updated",
        )
        brief_fields = ("id", "url", "display", "name", "description")
