import os


ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "*").split(" ")

DATABASES = {
    "default": {
        "NAME": os.environ.get("DB_NAME", "netbox"),
        "USER": os.environ.get("DB_USER", "netbox"),
        "PASSWORD": os.environ.get("DB_PASSWORD", ""),
        "HOST": os.environ.get("DB_HOST", "localhost"),
        "PORT": os.environ.get("DB_PORT", ""),
    }
}

REDIS = {
    "tasks": {
        "HOST": os.environ.get("REDIS_HOST", "localhost"),
        "PORT": int(os.environ.get("REDIS_PORT", "6379")),
        "PASSWORD": os.environ.get("REDIS_PASSWORD", ""),
        "DATABASE": int(os.environ.get("REDIS_DATABASE", "0")),
        "SSL": os.environ.get("REDIS_SSL", "False").lower() == "true",
    },
    "caching": {
        "HOST": os.environ.get("REDIS_CACHE_HOST", os.environ.get("REDIS_HOST", "localhost")),
        "PORT": int(os.environ.get("REDIS_CACHE_PORT", os.environ.get("REDIS_PORT", "6379"))),
        "PASSWORD": os.environ.get(
            "REDIS_CACHE_PASSWORD", os.environ.get("REDIS_PASSWORD", "")
        ),
        "DATABASE": int(os.environ.get("REDIS_CACHE_DATABASE", "1")),
        "SSL": os.environ.get("REDIS_CACHE_SSL", os.environ.get("REDIS_SSL", "False")).lower()
        == "true",
    },
}

SECRET_KEY = os.environ.get("SECRET_KEY", "")

# Enable the plugin
PLUGINS = [
    "netbox_cross_journal",
]

# All of this plugin's behavior (which sheets/columns to include, company header text,
# excluded device statuses) is configured live from within NetBox itself —
# Plugins -> Cross Journal Settings — not from PLUGINS_CONFIG.

# Local dev only — enables `manage.py makemigrations`, needed whenever
# netbox_cross_journal/models.py changes and a new migration must be generated. Never set
# this on a real deployment.
DEVELOPER = True
