# medien-dl

[![Docker Image CI](https://github.com/MrUnknownDE/medien-dl/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/MrUnknownDE/medien-dl/actions/workflows/docker-publish.yml)

`medien-dl` ist eine benutzerfreundliche Webanwendung, die es ermöglicht, Medieninhalte von verschiedenen sozialen Plattformen herunterzuladen und direkt in einen S3-kompatiblen Speicher (wie AWS S3, Cloudflare R2 oder MinIO) hochzuladen.

Die App bietet eine einfache Weboberfläche zur Steuerung der Downloads, zeigt den Fortschritt in Echtzeit an und führt einen Verlauf über alle abgeschlossenen Aufträge.

![Screenshot der Anwendung](https://i.imgur.com/DeinScreenshot.png)  <!-- Ersetze dies durch einen echten Screenshot deiner App -->

## ✨ Features

- **Breite Plattformunterstützung:**
  - <i class="fab fa-soundcloud"></i> **SoundCloud** (MP3)
  - <i class="fab fa-youtube"></i> **YouTube** (MP3 & MP4)
  - <i class="fab fa-tiktok"></i> **TikTok** (MP4)
  - <i class="fab fa-instagram"></i> **Instagram** (Reels & Posts als MP4)
  - <i class="fab fa-x-twitter"></i> **Twitter / X** (Videos als MP4)
- **Flexible Qualitätsauswahl:** Wähle die gewünschte Bitrate für MP3s und die Videoqualität für MP4s.
- **Video-Kompatibilität:** Optionale Konvertierung von Videos in das weit verbreitete H.264-Format für maximale Kompatibilität.
- **S3-kompatibler Upload:** Funktioniert mit AWS S3, Cloudflare R2, DigitalOcean Spaces, Wasabi, MinIO und mehr.
- **Echtzeit-Statusupdates:** Verfolge den Fortschritt von Download, Konvertierung und Upload direkt im Browser.
- **Download-Verlauf:** Eine Übersicht über alle bisher heruntergeladenen Medien (optional).
- **Statistiken:** Einfache Statistiken über die Gesamtzahl der Aufträge, die durchschnittliche Dauer und die hochgeladene Datenmenge.
- **Einfaches Setup:** Dank Docker und Docker Compose in wenigen Minuten einsatzbereit.

## 🚀 Schnellstart mit Docker

Die einfachste Methode, die Anwendung zu starten, ist die Verwendung von Docker und Docker Compose.

### Voraussetzungen
- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/) (in den meisten Docker-Desktop-Installationen enthalten)

### Installationsschritte

1.  **Repository klonen:**
    ```bash
    git clone https://github.com/MrUnknownDE/medien-dl.git
    cd medien-dl
    ```

2.  **Konfigurationsdatei erstellen:**
    Kopiere die Beispiel-Konfigurationsdatei `.env.example` nach `.env`.
    ```bash
    cp .env.example .env
    ```

3.  **`.env`-Datei anpassen:**
    Öffne die `.env`-Datei mit einem Texteditor und trage deine Zugangsdaten für den S3-Speicher ein. **Dies ist der wichtigste Schritt!**

4.  **Datenverzeichnisse erstellen:**
    Die Anwendung benötigt Verzeichnisse, um den Verlauf und die Statistiken persistent zu speichern.
    ```bash
    mkdir -p data/sc_downloads
    touch data/download_history.json
    touch data/stats.json
    ```

5.  **Anwendung starten:**
    Starte die Anwendung im Hintergrund mit Docker Compose.
    ```bash
    docker-compose up -d
    ```

Die Webanwendung ist nun unter [http://localhost:5000](http://localhost:5000) erreichbar.

## ⚙️ Konfiguration

Alle Konfigurationen werden über die `.env`-Datei gesteuert.

| Variable | Erforderlich | Beschreibung | Beispiel |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID` | **Ja** | Deine Access Key ID für den S3-Speicher. | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | **Ja** | Dein Secret Access Key für den S3-Speicher. | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `AWS_S3_BUCKET_NAME` | **Ja** | Der Name deines S3-Buckets. | `mein-medien-bucket` |
| `AWS_REGION` | **Ja** | Die Region deines S3-Anbieters. Für Cloudflare R2 `auto` verwenden. | `eu-central-1` |
| `S3_ENDPOINT_URL` | Nein | Die Endpoint-URL für S3-kompatible Anbieter (nicht für AWS S3). | `https://<accountid>.r2.cloudflarestorage.com` |
| `S3_PUBLIC_URL_BASE` | **Ja** | Die öffentliche Basis-URL deines Buckets. **Wichtig für den finalen Link!** | `https://pub-<hash>.r2.dev/` |
| `ENABLE_HISTORY` | Nein | Aktiviert (`true`) oder deaktiviert (`false`) die Verlaufsfunktion. | `true` |
| `MAX_WORKERS` | Nein | Anzahl der parallelen Verarbeitungs-Threads. **`1` wird empfohlen**, da die UI-Anzeige sonst nicht synchron ist. | `1` |
| `COOKIE_FILE_PATH` | Nein | Pfad zu einer Cookie-Datei (Netscape-Format) für Downloads, die einen Login erfordern (z.B. private Inhalte). | `/app/cookies/instagram.txt` |

## 🛠️ Technologie-Stack

- **Backend:** Python, Flask
- **Download-Engine:** `yt-dlp`
- **Cloud-Anbindung:** `boto3` (AWS SDK)
- **WSGI-Server:** Gunicorn
- **Containerisierung:** Docker, Docker Compose
- **Frontend:** Bootstrap 5, Font Awesome, JavaScript

## Lizenz

Dieses Projekt steht unter der [MIT-Lizenz](LICENSE).