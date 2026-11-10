# The Maven stage builds a warm-up project once so the local repository holds Maven's
# default plugins and JUnit 5. Sandboxed runs have no network and build offline.
FROM maven:3.10.0-eclipse-temurin-21 AS maven
COPY maven /cache-project
RUN mvn --batch-mode --no-transfer-progress -Dmaven.repo.local=/maven-repo \
    -f /cache-project/pom.xml test

FROM python:3.12-slim
COPY --from=maven /opt/java/openjdk /opt/java/openjdk
COPY --from=maven /usr/share/maven /usr/share/maven
COPY --from=maven /maven-repo /opt/maven-repo
RUN ln -s /opt/java/openjdk/bin/java /usr/local/bin/java \
    && ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn
WORKDIR /input/workspace
COPY runner.py /runner.py
RUN mkdir -p /workspace /evidence && chmod 555 /workspace /evidence /runner.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/input/workspace
USER 65534:65534
ENTRYPOINT ["python", "-I", "/runner.py"]
