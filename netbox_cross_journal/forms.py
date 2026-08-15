from __future__ import annotations

from django import forms
from django.utils.translation import gettext_lazy as _

from dcim.choices import DeviceStatusChoices

from .models import CrossJournalSettings


class CrossJournalSettingsForm(forms.ModelForm):
    excluded_statuses = forms.MultipleChoiceField(
        choices=DeviceStatusChoices,
        required=False,
        label=_("excluded device statuses"),
        widget=forms.SelectMultiple(attrs={"class": "form-select"}),
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
