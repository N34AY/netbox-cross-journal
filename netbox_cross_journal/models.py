from django.db import models
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from netbox.models import NetBoxModel

DEFAULT_EXCLUDED_STATUSES = ["decommissioning"]

EXCEL_LAYOUT_CHOICES = (
    ("split", _("Separate sheets (Devices / Data / Power)")),
    ("single", _("Single sheet (everything combined)")),
)


class CrossJournalSettings(models.Model):
    """Singleton model for plugin-wide report generation settings."""

    company_name = models.CharField(
        max_length=200,
        blank=True,
        verbose_name=_("company name"),
        help_text=_("Shown in the report header (optional)."),
    )
    include_data_cables = models.BooleanField(
        default=True,
        verbose_name=_("include data cables"),
    )
    include_power_cables = models.BooleanField(
        default=True,
        verbose_name=_("include power cables"),
    )
    include_tags = models.BooleanField(
        default=True,
        verbose_name=_("include tags"),
    )
    include_ip_addresses = models.BooleanField(
        default=True,
        verbose_name=_("include IP addresses"),
    )
    include_serial_numbers = models.BooleanField(
        default=True,
        verbose_name=_("include serial numbers"),
    )
    include_comments = models.BooleanField(
        default=True,
        verbose_name=_("include comments"),
        help_text=_("Device comments can be long or contain internal notes."),
    )
    excel_layout = models.CharField(
        max_length=10,
        choices=EXCEL_LAYOUT_CHOICES,
        default="split",
        verbose_name=_("Excel file layout"),
    )
    excluded_statuses = models.JSONField(
        default=list,
        blank=True,
        verbose_name=_("excluded device statuses"),
        help_text=_("Devices with these statuses are left out of the report (e.g. “decommissioning”)."),
    )
    passthrough_device_types = models.ManyToManyField(
        to="dcim.DeviceType",
        blank=True,
        related_name="+",
        verbose_name=_("passthrough device types"),
        help_text=_(
            "Device types (e.g. a splice/distribution box) that a box diagram should see "
            "through rather than treat as the final destination — the diagram keeps following "
            "the cable chain past any of these until it reaches a real endpoint, however many "
            "of them are chained in a row."
        ),
    )

    class Meta:
        verbose_name = _("settings")
        verbose_name_plural = _("settings")

    def __str__(self):
        return str(_("Cross Journal Settings"))

    @classmethod
    def load(cls):
        obj, created = cls.objects.get_or_create(
            pk=1, defaults={"excluded_statuses": DEFAULT_EXCLUDED_STATUSES}
        )
        return obj


class TopologyLayout(NetBoxModel):
    """A saved view of the topology page: its filters plus, for hand-arranged diagrams, where
    each card was dragged to. Only the arrangement is stored — devices and cables are always
    read live from NetBox, so a saved layout keeps up with changes (a new cable just appears;
    a new device without a stored position is placed off to the side for the user to move)."""

    name = models.CharField(max_length=100, unique=True, verbose_name=_("name"))
    description = models.CharField(max_length=200, blank=True, verbose_name=_("description"))
    # Same shape as the page's URL-hash state (facet selections, connection kinds, toggles).
    filters = models.JSONField(default=dict, blank=True, verbose_name=_("filters"))
    # "auto" = ELK decides everything; "manual" = cards sit where they were dragged.
    mode = models.CharField(max_length=10, default="auto", verbose_name=_("mode"))
    # How cables are drawn between hand-placed cards (see topology.js).
    routing = models.CharField(max_length=20, default="orthogonal", verbose_name=_("cable routing"))
    # Node id ("d<device pk>", "opowerfeed<pk>"...) -> {"x": .., "y": ..}
    positions = models.JSONField(default=dict, blank=True, verbose_name=_("positions"))

    class Meta:
        ordering = ["name"]
        verbose_name = _("topology layout")
        verbose_name_plural = _("topology layouts")

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("plugins:netbox_cross_journal:topologylayout", args=[self.pk])

    def get_diagram_url(self):
        return reverse("plugins:netbox_cross_journal:topology") + f"?layout={self.pk}"
