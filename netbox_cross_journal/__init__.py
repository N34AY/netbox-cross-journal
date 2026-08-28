from netbox.plugins import PluginConfig


class CrossJournalConfig(PluginConfig):
    name = "netbox_cross_journal"
    verbose_name = "Cross Journal"
    description = (
        "Generates a printable/Excel cross-connect journal (device inventory, data "
        "cabling, power cabling) scoped to a Rack, Location, or Site."
    )
    version = "0.8.0"
    base_url = "cross-journal"

    template_extensions = "template_content.template_extensions"


config = CrossJournalConfig
