from netbox.api.viewsets import NetBoxModelViewSet

from ..filtersets import TopologyLayoutFilterSet
from ..models import TopologyLayout
from .serializers import TopologyLayoutSerializer


class TopologyLayoutViewSet(NetBoxModelViewSet):
    queryset = TopologyLayout.objects.prefetch_related("tags")
    serializer_class = TopologyLayoutSerializer
    filterset_class = TopologyLayoutFilterSet
