ARG BASE_IMAGE=frappe/erpnext@sha256:a9dea1cc498aa08010eb3567f1808c7bed98e4b9d17dcbd4265791c9ad00971e
FROM ${BASE_IMAGE}
USER root
COPY --chown=frappe:frappe app /home/frappe/frappe-bench/apps/tradept_core
COPY wheels /opt/tradept-wheels
USER frappe
RUN /home/frappe/frappe-bench/env/bin/python -m pip install --no-index --find-links=/opt/tradept-wheels setuptools wheel \
 && /home/frappe/frappe-bench/env/bin/python -m pip install --no-build-isolation --no-deps -e /home/frappe/frappe-bench/apps/tradept_core
ENV PYTHONDONTWRITEBYTECODE=1
