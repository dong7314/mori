# Same official release used in the home-cluster tool experiments. No model weights.
FROM nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808
USER root
# Kubernetes owns restarts. Avoid creating a second dynamic s6 gateway service
# after the official entrypoint drops privileges to uid 10000.
ENV HERMES_GATEWAY_NO_SUPERVISE=1
COPY requirements.lock /opt/mori/requirements.lock
RUN python3 -m venv /opt/mori/extract-venv && \
    uv --no-config pip install --require-hashes --python /opt/mori/extract-venv/bin/python --requirement /opt/mori/requirements.lock && \
    uv --no-config pip check --python /opt/mori/extract-venv/bin/python
COPY plugins /opt/mori/plugins
COPY bootstrap.py /opt/mori/bootstrap.py
COPY checks /opt/mori/checks
RUN chmod -R a+rX /opt/mori && \
    /opt/mori/extract-venv/bin/python -c "from importlib.metadata import version; assert version('trafilatura') == '2.2.0'" && \
    python -c "from agent.web_search_provider import WebSearchProvider; from hermes_cli.plugins import PluginContext; assert hasattr(PluginContext, 'register_web_search_provider')"
# Preserve the official s6 entrypoint, privilege drop and signal handling.
CMD ["gateway", "run"]
