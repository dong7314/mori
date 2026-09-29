# Same official release used in the home-cluster tool experiments. No model weights.
FROM nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808
USER root
# The Mori entrypoint runs one foreground gateway; Kubernetes owns restarts.
ENV HERMES_GATEWAY_NO_SUPERVISE=1
COPY requirements.lock /opt/mori/requirements.lock
RUN python3 -m venv /opt/mori/extract-venv && \
    uv --no-config pip install --require-hashes --python /opt/mori/extract-venv/bin/python --requirement /opt/mori/requirements.lock && \
    uv --no-config pip check --python /opt/mori/extract-venv/bin/python
# Korean PDF output uses an embedded font; no browser, OCR or office daemon.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-nanum && \
    rm -rf /var/lib/apt/lists/*
COPY documents-requirements.lock /opt/mori/documents-requirements.lock
RUN python3 -m venv /opt/mori/documents-venv && \
    uv --no-config pip install --require-hashes --python /opt/mori/documents-venv/bin/python --requirement /opt/mori/documents-requirements.lock && \
    uv --no-config pip check --python /opt/mori/documents-venv/bin/python
COPY plugins /opt/mori/plugins
COPY bootstrap.py /opt/mori/bootstrap.py
COPY checks /opt/mori/checks
RUN chmod -R a+rX /opt/mori && \
    /opt/mori/extract-venv/bin/python -c "from importlib.metadata import version; assert version('trafilatura') == '2.2.0'" && \
    python -c "from agent.web_search_provider import WebSearchProvider; from hermes_cli.plugins import PluginContext; assert hasattr(PluginContext, 'register_web_search_provider')"
# The base's /usr/bin/tini is an s6 compatibility shell script, not real tini.
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && \
    rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /opt/mori/entrypoint.sh
# Pinned Hermes treats SIGINT as a planned stop, but bare SIGTERM as a failure.
# Forward only to the gateway so it can drain its own work; never mask exit codes.
ENTRYPOINT ["/usr/bin/dumb-init", "--single-child", "--rewrite", "15:2", "--", "/bin/sh", "/opt/mori/entrypoint.sh"]
CMD ["gateway", "run"]
