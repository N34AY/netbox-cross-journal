from django.db import models
from django.utils.translation import gettext_lazy as _

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
