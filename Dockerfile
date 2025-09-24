# 1. Basis-Image wählen (Python 3.13 oder neuer empfohlen)
FROM python:3.13.3-slim

# 2. Metadaten (optional)
LABEL maintainer="MrUnknownDE"
LABEL description="Webapp zum Download von SoundCloud/YouTube/TikTok Tracks und Upload zu S3."

# 3. Umgebungsvariablen setzen
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0
ENV FLASK_ENV=production
# ENV GUNICORN_CMD_ARGS="--timeout 120" # Beispiel für zusätzliche Gunicorn Args

# 4. Systemabhängigkeiten installieren (inkl. FFmpeg)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# 5. Arbeitsverzeichnis im Container erstellen und setzen
WORKDIR /app

# 6. Python-Abhängigkeiten installieren
COPY requirements.txt ./
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 7. Anwendungs-Code in das Arbeitsverzeichnis kopieren
COPY . .

# 8. Port freigeben, auf dem die App lauschen wird
EXPOSE 5000

# 9. Befehl zum Starten der Anwendung mit Gunicorn
#    WICHTIG: --workers 1 ist entscheidend für diese Lösung!
#    --timeout erhöht, falls Downloads/Uploads lange dauern
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--timeout", "120", "app:app"]