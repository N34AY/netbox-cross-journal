from django.utils.translation import gettext_lazy as _

from netbox.plugins import PluginMenu, PluginMenuItem

_items = (
    PluginMenuItem(
        link="plugins:netbox_cross_journal:settings",
        link_text=_("Settings"),
        permissions=["netbox_cross_journal.change_crossjournalsettings"],
    ),
)

menu = PluginMenu(
    label=_("Cross Journal"),
    groups=((_("Cross Journal"), _items),),
    icon_class="mdi mdi-file-table-outline",
)
