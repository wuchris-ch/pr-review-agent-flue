FROM python:3.12-slim
WORKDIR /input/workspace
COPY runner.py /runner.py
RUN mkdir -p /workspace /evidence && chmod 555 /workspace /evidence /runner.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/input/workspace
USER 65534:65534
ENTRYPOINT ["python", "-I", "/runner.py"]
