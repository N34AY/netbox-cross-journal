ARG NETBOX_VERSION=v4.6.8-5.0.2

FROM docker.io/netboxcommunity/netbox:${NETBOX_VERSION}

# Topology diagrams are rendered with the `graphviz` Python package, which shells out to the
# system `dot`/`neato` binaries — the pip package alone isn't enough. Build runs as root
# (docker-compose's `user: netbox:root` only applies at container-run time).
#
# `graphviz` alone only ships the "dot" layout engine — neato/fdp/etc. are a separate plugin
# package (`libgvplugin-neato-layout8`) that `--no-install-recommends` drops by default,
# which makes `dot -Kneato ...` fail with "no layout engine support for neato" even though
# the `neato` binary itself exists (it's a thin wrapper around the same plugin lookup).
RUN apt-get update && apt-get install -y --no-install-recommends \
        graphviz libgvplugin-neato-layout8 \
    && rm -rf /var/lib/apt/lists/*

# Install this repo as a NetBox plugin (editable). At runtime, docker-compose
# mounts the repo into the same path, so changes are reflected.
COPY . /opt/netbox-plugin-src

RUN uv pip install --python /opt/netbox/venv/bin/python --no-cache -e /opt/netbox-plugin-src
