from django.utils.translation import gettext_lazy as _

from netbox.plugins import PluginMenu, PluginMenuButton, PluginMenuItem

_items = (
    PluginMenuItem(
        link="plugins:netbox_cross_journal:topology",
        link_text=_("Topology"),
    ),
    PluginMenuItem(
        link="plugins:netbox_cross_journal:topologylayout_list",
        link_text=_("Saved layouts"),
        permissions=["netbox_cross_journal.view_topologylayout"],
        buttons=(
            PluginMenuButton(
                link="plugins:netbox_cross_journal:topologylayout_add",
                title=_("Add"),
                icon_class="mdi mdi-plus-thick",
                permissions=["netbox_cross_journal.add_topologylayout"],
            ),
        ),
    ),
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
