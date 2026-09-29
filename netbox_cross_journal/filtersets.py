from django.db.models import Q
from netbox.filtersets import NetBoxModelFilterSet

from .models import TopologyLayout


class TopologyLayoutFilterSet(NetBoxModelFilterSet):
    class Meta:
        model = TopologyLayout
        fields = ("id", "name", "mode")

    def search(self, queryset, name, value):
        if not value.strip():
            return queryset
        return queryset.filter(Q(name__icontains=value) | Q(description__icontains=value))
