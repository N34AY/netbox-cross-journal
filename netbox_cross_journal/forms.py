from __future__ import annotations

from django import forms
from django.utils.translation import gettext_lazy as _

from dcim.choices import DeviceStatusChoices
from dcim.models import DeviceType

from .models import CrossJournalSettings


class CrossJournalSettingsForm(forms.ModelForm):
    excluded_statuses = forms.MultipleChoiceField(
        choices=DeviceStatusChoices,
        required=False,
        label=_("excluded device statuses"),
        widget=forms.SelectMultiple(attrs={"class": "form-select"}),
    )
    passthrough_device_types = forms.ModelMultipleChoiceField(
        queryset=DeviceType.objects.select_related("manufacturer").order_by(
            "manufacturer__name", "model"
        ),
        required=False,
        label=_("passthrough device types"),
        help_text=_(
            "Box diagrams see through devices of these types (e.g. a splice/distribution "
            "box) instead of stopping at them — the chain is followed however many are in a "
            "row until a real endpoint is reached."
        ),
        widget=forms.SelectMultiple(attrs={"class": "form-select", "size": 8}),
    )

    class Meta:
        model = CrossJournalSettings
        fields = [
            "company_name",
            "include_data_cables",
            "include_power_cables",
            "include_tags",
            "include_ip_addresses",
            "include_serial_numbers",
            "include_comments",
            "excel_layout",
            "excluded_statuses",
            "passthrough_device_types",
        ]
        widgets = {
            "company_name": forms.TextInput(attrs={"class": "form-control"}),
            "include_data_cables": forms.CheckboxInput(attrs={"class": "form-check-input"}),
            "include_power_cables": forms.CheckboxInput(attrs={"class": "form-check-input"}),
            "include_tags": forms.CheckboxInput(attrs={"class": "form-check-input"}),
            "include_ip_addresses": forms.CheckboxInput(attrs={"class": "form-check-input"}),
            "include_serial_numbers": forms.CheckboxInput(attrs={"class": "form-check-input"}),
            "include_comments": forms.CheckboxInput(attrs={"class": "form-check-input"}),
            "excel_layout": forms.Select(attrs={"class": "form-select"}),
        }
