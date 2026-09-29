from netbox.api.routers import NetBoxRouter

from . import views

router = NetBoxRouter()
router.register("topology-layouts", views.TopologyLayoutViewSet)
urlpatterns = router.urls
