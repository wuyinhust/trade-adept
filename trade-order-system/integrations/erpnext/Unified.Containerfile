ARG BASE_IMAGE=frappe/erpnext@sha256:8ef14960b8b4108e764e56e68b2451f200664197686537b74fe39b627e1f6b63
FROM ${BASE_IMAGE}
USER root
COPY --chown=frappe:frappe app /home/frappe/frappe-bench/apps/tradept_core
COPY wheels /opt/tradept-wheels
USER frappe
RUN /home/frappe/frappe-bench/env/bin/python -m pip install --no-index --find-links=/opt/tradept-wheels setuptools wheel \
 && /home/frappe/frappe-bench/env/bin/python -m pip install --no-build-isolation --no-deps -e /home/frappe/frappe-bench/apps/tradept_core
USER root
RUN /home/frappe/frappe-bench/env/bin/python -c "from tradept_core.assets import ensure; ensure('/home/frappe/frappe-bench/sites/assets')"
USER frappe
ENV PYTHONDONTWRITEBYTECODE=1
