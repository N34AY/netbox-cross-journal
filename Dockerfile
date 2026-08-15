ARG NETBOX_VERSION=v4.6.8-5.0.2

FROM docker.io/netboxcommunity/netbox:${NETBOX_VERSION}

# Install this repo as a NetBox plugin (editable). At runtime, docker-compose
# mounts the repo into the same path, so changes are reflected.
COPY . /opt/netbox-plugin-src

RUN uv pip install --python /opt/netbox/venv/bin/python --no-cache -e /opt/netbox-plugin-src
