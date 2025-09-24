# -*- coding: utf-8 -*-
import threading
import os
import sys
import yt_dlp
import boto3
from botocore.exceptions import NoCredentialsError, ClientError
import logging
from dotenv import load_dotenv
import urllib.parse
import json
from datetime import datetime
import random
import string
import re
from flask import Flask, render_template, request, jsonify, Response, copy_current_request_context
import time
# import queue # ALT
import multiprocessing # NEU: Für prozessübergreifende Queue
import math
import uuid
import subprocess # NEU: Für FFmpeg Aufruf
import traceback # NEU: Für detaillierte Fehlermeldungen

# --- Konstanten ---
HISTORY_FILE = "download_history.json"
STATS_FILE = "stats.json"
RANDOM_NAME_LENGTH = 4
MAX_FILENAME_RETRIES = 10
ANSI_ESCAPE_REGEX = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
URL_REGEX = re.compile(r'https?://[^\s<>"]+|www\.[^\s<>"]+')
# NEU: Plattformen expliziter definieren
SUPPORTED_PLATFORMS = ["SoundCloud", "YouTube", "TikTok", "Instagram", "Twitter"]
DEFAULT_PLATFORM = "SoundCloud"
DEFAULT_YT_FORMAT = "mp3"
MP3_BITRATES = ["Best", "256k", "192k", "128k", "64k"]
MP4_QUALITIES = ["Best", "Medium (~720p)", "Low (~480p)"]
DEFAULT_MP3_BITRATE = "192k"
DEFAULT_MP4_QUALITY = "Best"
DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sc_downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)
JOB_STATUS_TTL_SECONDS = 300 # 5 Minuten Lebenszeit für abgeschlossene Job-Status
# NEU: FFmpeg Kompatibilitäts-Parameter
FFMPEG_COMPAT_ARGS = [
    '-c:v', 'libx264',       # Video Codec: H.264
    '-profile:v', 'main',    # Profil: Main (gute Kompatibilität & Qualität)
    '-preset', 'fast',       # Encoding-Geschwindigkeit (Kompromiss)
    '-pix_fmt', 'yuv420p',   # Pixelformat (sehr kompatibel)
    '-c:a', 'aac',           # Audio Codec: AAC (Standard für MP4)
    '-b:a', '128k',          # Audio Bitrate
    '-movflags', '+faststart' # Für Web-Streaming optimieren
]

# --- Konfiguration für Logging ---
log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - [%(threadName)s] - %(message)s') # ThreadName hinzugefügt
log_handler = logging.StreamHandler(sys.stdout)
log_handler.setFormatter(log_formatter)
logger = logging.getLogger()
logger.setLevel(logging.INFO)
# Verhindere doppelte Handler, falls die App neu geladen wird (z.B. bei Flask Debug)
if not logger.hasHandlers():
    logger.addHandler(log_handler)
elif len(logger.handlers) > 1:
     for handler in logger.handlers[:-1]:
         logger.removeHandler(handler)


# --- Lade Umgebungsvariablen ---
dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
env_loaded_successfully = load_dotenv(dotenv_path=dotenv_path)
if env_loaded_successfully: logging.info(f".env Datei gefunden und geladen von: {dotenv_path}")
else: logging.warning(".env Datei nicht gefunden...")

# --- Konfiguration aus .env lesen ---
ENABLE_HISTORY = os.getenv('ENABLE_HISTORY', 'true').lower() == 'true'
try:
    MAX_WORKERS = int(os.getenv('MAX_WORKERS', '1'))
    if MAX_WORKERS < 1:
        MAX_WORKERS = 1
        logging.warning("MAX_WORKERS muss mindestens 1 sein, wurde auf 1 gesetzt.")
except ValueError:
    MAX_WORKERS = 1
    logging.warning("Ungültiger Wert für MAX_WORKERS in .env, verwende Standardwert 1.")

if MAX_WORKERS <= 0: MAX_WORKERS = 1 # Sicherstellen, dass mindestens 1 Worker läuft

logging.info(f"Verlauf aktiviert: {ENABLE_HISTORY}")
logging.info(f"Maximale Worker-Threads (für Hintergrundverarbeitung): {MAX_WORKERS}")

# --- Flask App Initialisierung ---
app = Flask(__name__)
app.secret_key = os.urandom(24)

# --- Globaler Status -> Job-Status Speicher ---
manager = multiprocessing.Manager()
job_statuses = manager.dict()
task_lock = threading.Lock()

# --- Worker Queue (Prozesssicher) ---
task_queue = multiprocessing.Queue()

# --- Hilfsfunktionen (Backend - unverändert) ---
def generate_random_part(length=RANDOM_NAME_LENGTH):
    characters = string.ascii_lowercase + string.digits
    return ''.join(random.choice(characters) for _ in range(length))

def generate_s3_object_name(extension):
    year_part = datetime.now().strftime("%y")
    random_part = generate_random_part()
    if not extension.startswith('.'): extension = '.' + extension
    return f"{year_part}{random_part}{extension.lower()}"

def strip_ansi_codes(text):
    return ANSI_ESCAPE_REGEX.sub('', text)

def format_size(size_bytes):
   if size_bytes == 0: return "0 B"
   size_name = ("B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB")
   i = int(math.floor(math.log(size_bytes, 1024))) if size_bytes > 0 else 0
   p = math.pow(1024, i)
   s = round(size_bytes / p, 2) if p > 0 else 0
   return f"{s} {size_name[i]}"

# --- Status Update Funktion (leicht angepasst für Manager Dict) ---
def update_status(job_id, message=None, progress=None, log_entry=None, error=None, result_url=None, running=None, status_code=None):
    with task_lock:
        if job_id not in job_statuses:
            logging.warning(f"Versuch, Status für unbekannten Job {job_id} zu aktualisieren.")
            return
        current_job_status = dict(job_statuses[job_id])
        current_job_status["last_update"] = time.time()
        if message is not None: current_job_status["message"] = message
        if progress is not None: current_job_status["progress"] = max(0.0, min(100.0, float(progress)))
        if log_entry is not None:
            clean_log = strip_ansi_codes(str(log_entry))
            if "logs" not in current_job_status or not isinstance(current_job_status["logs"], list):
                 current_job_status["logs"] = []
            log_list = list(current_job_status["logs"])
            log_list.append(f"{datetime.now().strftime('%H:%M:%S')} - {clean_log}")
            max_logs = 100
            current_job_status["logs"] = log_list[-max_logs:]
        if error is not None:
            current_job_status["error"] = strip_ansi_codes(str(error))
            current_job_status["running"] = False
            current_job_status["message"] = f"Fehler: {current_job_status['error']}"
            current_job_status["status"] = "error"
            logging.error(f"Job Error [{job_id}]: {current_job_status['error']}")
        if result_url is not None: current_job_status["result_url"] = result_url
        if running is not None:
            current_job_status["running"] = bool(running)
            if not current_job_status["running"]:
                if not current_job_status.get("error"):
                    if current_job_status.get("status") not in ["error", "queued", "completed"]:
                        current_job_status["status"] = "completed"
                        current_job_status["message"] = current_job_status.get("message", "Abgeschlossen!")
        if status_code is not None:
            current_job_status["status"] = status_code
        job_statuses[job_id] = current_job_status

# --- Callback-Erzeuger (unverändert) ---
def create_status_callback(job_id):
    def callback(message):
        update_status(job_id, log_entry=message, message=message)
    return callback

def create_progress_callback(job_id):
    def callback(value):
        update_status(job_id, progress=value)
    return callback

# --- Kernfunktionen ---
def download_track(job_id, url, platform, format_preference, mp3_bitrate, mp4_quality, codec_preference, output_path="."):
    track_title = None; final_extension = None
    status_callback = create_status_callback(job_id)
    progress_callback = create_progress_callback(job_id)

    status_callback(f"Starte Download von {platform}...")
    progress_callback(0.0)
    os.makedirs(output_path, exist_ok=True)

    last_reported_progress = -1

    def _progress_hook_logic(d):
        nonlocal last_reported_progress
        if d['status'] == 'downloading':
            filename = strip_ansi_codes(d.get('info_dict', {}).get('title', d.get('filename', 'Datei')))
            percent_str = strip_ansi_codes(d.get('_percent_str', 'N/A')).strip()
            speed_str = strip_ansi_codes(d.get('_speed_str', 'N/A')).strip()
            eta_str = strip_ansi_codes(d.get('_eta_str', 'N/A')).strip()
            total_bytes_str = strip_ansi_codes(d.get('_total_bytes_str', 'N/A')).strip()
            percent_float = None
            try:
                percent_str_cleaned = percent_str.replace('%','').strip()
                percent_float = float(percent_str_cleaned)
                if progress_callback: progress_callback(percent_float)
            except ValueError:
                percent_float = 0.0
            current_prog = int(percent_float)
            if current_prog != -1 and (current_prog == 0 or current_prog == 100 or abs(current_prog - last_reported_progress) >= 5):
                 status_msg = f"Download: {filename} - {percent_str} von {total_bytes_str} @ {speed_str}, ETA: {eta_str}"
                 if status_callback: status_callback(status_msg)
                 last_reported_progress = current_prog
        elif d['status'] == 'finished':
            filename = strip_ansi_codes(d.get('filename', 'Datei'))
            if status_callback: status_callback(f"Download von {os.path.basename(filename)} beendet, prüfe Nachbearbeitung...")
            last_reported_progress = -1
        elif d['status'] == 'error':
            filename = strip_ansi_codes(d.get('filename', 'Datei'))
            if status_callback: status_callback(f"Fehler beim Download von {os.path.basename(filename)}.")
            last_reported_progress = -1

    needs_ffmpeg_conversion = (codec_preference == 'h264' and platform in ["YouTube", "TikTok", "Instagram", "Twitter"])
    if needs_ffmpeg_conversion:
        try:
            ffmpeg_check = subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True, check=True)
            logging.info(f"[{job_id}] FFmpeg gefunden, H.264 Konvertierung ist möglich.")
        except (FileNotFoundError, subprocess.CalledProcessError) as ffmpeg_err:
            error_msg = "Fehler: FFmpeg nicht gefunden oder nicht ausführbar. H.264 Konvertierung nicht möglich."
            status_callback(error_msg)
            logging.error(f"[{job_id}] {error_msg} Details: {ffmpeg_err}")
            update_status(job_id, error=error_msg, running=False)
            return None, None, None

    ydl_opts = {
        'outtmpl': os.path.join(output_path, '%(title)s.%(ext)s'),
        'noplaylist': True, 'quiet': True, 'noprogress': True,
        'ffmpeg_location': None, 'logger': logging.getLogger('yt_dlp'),
        'progress_hooks': [_progress_hook_logic],
        'restrictfilenames': True, 'writethumbnail': False, 'no_color': True,
        'postprocessors': [],
        'cookiefile': os.getenv('COOKIE_FILE_PATH') or None,
    }
    if ydl_opts['cookiefile']: logging.info(f"[{job_id}] Verwende Cookie-Datei: {ydl_opts['cookiefile']}")
    else: logging.info(f"[{job_id}] Keine Cookie-Datei konfiguriert.")

    # --- Format-Optionen ---
    if platform == "SoundCloud":
        final_extension = '.mp3'; ydl_opts['format'] = 'bestaudio/best'
        postprocessor_opts = {'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3'}
        if mp3_bitrate != "Best": postprocessor_opts['preferredquality'] = mp3_bitrate.replace('k', ''); logging.info(f"[{job_id}] MP3-Qualität angefordert: {mp3_bitrate}")
        else: logging.info(f"[{job_id}] MP3-Qualität angefordert: Best")
        ydl_opts['postprocessors'] = [postprocessor_opts]; ydl_opts['outtmpl'] = os.path.join(output_path, '%(title)s.mp3')
    elif platform == "YouTube" and format_preference == 'mp3':
        final_extension = '.mp3'; ydl_opts['format'] = 'bestaudio/best'
        postprocessor_opts = {'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3'}
        if mp3_bitrate != "Best": postprocessor_opts['preferredquality'] = mp3_bitrate.replace('k', ''); logging.info(f"[{job_id}] MP3-Qualität angefordert: {mp3_bitrate}")
        else: logging.info(f"[{job_id}] MP3-Qualität angefordert: Best")
        ydl_opts['postprocessors'] = [postprocessor_opts]; ydl_opts['outtmpl'] = os.path.join(output_path, '%(title)s.mp3')
    elif platform == "YouTube" and format_preference == 'mp4':
        final_extension = '.mp4'
        if mp4_quality == "Best": ydl_opts['format'] = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'; logging.info(f"[{job_id}] MP4-Qualität angefordert: Best")
        elif "Medium" in mp4_quality: ydl_opts['format'] = 'bestvideo[height<=?720][ext=mp4]+bestaudio[ext=m4a]/best[height<=?720][ext=mp4]/best[height<=?720]'; logging.info(f"[{job_id}] MP4-Qualität angefordert: Medium (~720p)")
        elif "Low" in mp4_quality: ydl_opts['format'] = 'bestvideo[height<=?480][ext=mp4]+bestaudio[ext=m4a]/best[height<=?480][ext=mp4]/best[height<=?480]'; logging.info(f"[{job_id}] MP4-Qualität angefordert: Low (~480p)")
        else: ydl_opts['format'] = 'best[ext=mp4]/best'; logging.warning(f"[{job_id}] Unbekannte MP4-Qualität '{mp4_quality}', verwende 'best'.")
        if codec_preference == 'h264': logging.info(f"[{job_id}] H.264 Konvertierung für YouTube MP4 angefordert (wird nach Download durchgeführt).")
        else: logging.info(f"[{job_id}] Original-Codec für YouTube MP4 beibehalten.")
    elif platform == "TikTok":
        final_extension = '.mp4'
        ydl_opts['format'] = 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best'
        logging.info(f"[{job_id}] TikTok Download angefordert (MP4 Best)")
        if codec_preference == 'h264': logging.info(f"[{job_id}] H.264 Konvertierung für TikTok angefordert (wird nach Download durchgeführt).")
        else: logging.info(f"[{job_id}] Original-Codec für TikTok beibehalten.")
    elif platform == "Instagram":
        final_extension = '.mp4'
        ydl_opts['format'] = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]/best[ext=mp4]/best'
        logging.info(f"[{job_id}] Instagram Reel Download angefordert (MP4 Best)")
        if codec_preference == 'h264': logging.info(f"[{job_id}] H.264 Konvertierung für Instagram angefordert (wird nach Download durchgeführt).")
        else: logging.info(f"[{job_id}] Original-Codec für Instagram beibehalten.")
    elif platform == "Twitter":
        final_extension = '.mp4'
        ydl_opts['format'] = 'bestvideo[ext=mp4]+bestaudio/bestvideo+bestaudio/best[ext=mp4]/best'
        logging.info(f"[{job_id}] Twitter Video Download angefordert (Format: {ydl_opts['format']})")
        if codec_preference == 'h264': logging.info(f"[{job_id}] H.264 Konvertierung für Twitter angefordert (wird nach Download durchgeführt).")
        else: logging.info(f"[{job_id}] Original-Codec für Twitter beibehalten.")
    else:
         status_callback(f"Fehler: Ungültige Kombination: {platform}/{format_preference}")
         update_status(job_id, error=f"Ungültige Kombination: {platform}/{format_preference}", running=False)
         return None, None, None

    downloaded_file_path = None; actual_downloaded_filename = None
    original_download_path = None

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            status_callback("Extrahiere Informationen...")
            info_dict = ydl.extract_info(url, download=False); track_title = info_dict.get('title', 'Unbekannter Titel')
            if platform in ["Instagram", "Twitter"] and not track_title:
                track_title = f"{platform}_Video_{info_dict.get('id', generate_random_part(6))}"
                logging.info(f"[{job_id}] Kein Titel gefunden, verwende generierten Titel: {track_title}")
            elif platform in ["Instagram", "Twitter"]:
                 track_title = URL_REGEX.sub('', track_title).strip()
                 if not track_title: track_title = f"{platform}_Video_{info_dict.get('id', generate_random_part(6))}"

            sanitized_title_for_filename = ydl.prepare_filename(info_dict)
            base_name_from_title = os.path.splitext(os.path.basename(sanitized_title_for_filename))[0]

            if platform == "SoundCloud" or (platform == "YouTube" and format_preference == 'mp3'): final_extension = '.mp3'
            elif platform in ["YouTube", "TikTok", "Instagram", "Twitter"]: final_extension = '.mp4'
            else: final_extension = '.mp4' if format_preference == 'mp4' else '.mp3'; logging.warning(f"[{job_id}] Unerwarteter Fall bei Endungsbestimmung, verwende {final_extension}")

            status_callback(f"Downloade '{track_title}'...")
            ydl.download([url])

            downloaded_file_path = None
            possible_extensions = [final_extension]
            if final_extension == '.mp4': possible_extensions.extend(['.webm', '.mkv', '.mov', '.avi'])
            found_file = None; latest_mtime = 0
            for f in os.listdir(output_path):
                file_base, file_ext = os.path.splitext(f)
                if file_base.lower().startswith(base_name_from_title.lower()) and file_ext.lower() in possible_extensions:
                    current_path = os.path.join(output_path, f)
                    current_mtime = os.path.getmtime(current_path)
                    if current_mtime > latest_mtime:
                        found_file = current_path; latest_mtime = current_mtime
            if found_file:
                downloaded_file_path = found_file; original_download_path = downloaded_file_path
                actual_downloaded_filename = os.path.basename(downloaded_file_path)
                status_callback(f"Download abgeschlossen: {actual_downloaded_filename}")
                logging.info(f"[{job_id}] Datei heruntergeladen: {downloaded_file_path}")
            else:
                error_msg = f"Fehler: Konnte heruntergeladene Datei für '{track_title}' nicht im Ordner '{output_path}' finden."
                status_callback(error_msg); logging.error(f"[{job_id}] {error_msg}")
                update_status(job_id, error=error_msg, running=False)
                return None, None, None

            if needs_ffmpeg_conversion and downloaded_file_path:
                status_callback("Starte H.264 Kompatibilitäts-Konvertierung (kann dauern)...")
                logging.info(f"[{job_id}] Starte explizite FFmpeg H.264 Konvertierung für: {downloaded_file_path}")
                base_name, _ = os.path.splitext(downloaded_file_path)
                converted_file_path = f"{base_name}_h264.mp4"; final_extension = '.mp4'
                ffmpeg_command = ['ffmpeg', '-i', downloaded_file_path, '-y'] + FFMPEG_COMPAT_ARGS + [converted_file_path]
                logging.info(f"[{job_id}] FFmpeg Befehl: {' '.join(ffmpeg_command)}")
                try:
                    process = subprocess.run(ffmpeg_command, capture_output=True, text=True, check=True)
                    logging.info(f"[{job_id}] FFmpeg Konvertierung erfolgreich abgeschlossen.")
                    logging.debug(f"[{job_id}] FFmpeg stderr:\n{process.stderr}")
                    status_callback("H.264 Konvertierung erfolgreich.")
                    downloaded_file_path = converted_file_path
                    actual_downloaded_filename = os.path.basename(downloaded_file_path)
                    if original_download_path and os.path.exists(original_download_path) and original_download_path != downloaded_file_path:
                        try: os.remove(original_download_path); logging.info(f"[{job_id}] Ursprüngliche Datei '{os.path.basename(original_download_path)}' nach Konvertierung gelöscht.")
                        except OSError as del_err: logging.warning(f"[{job_id}] Konnte ursprüngliche Datei '{os.path.basename(original_download_path)}' nicht löschen: {del_err}")
                except subprocess.CalledProcessError as e:
                    error_msg = f"Fehler bei der H.264 Konvertierung mit FFmpeg."
                    logging.error(f"[{job_id}] {error_msg} Rückgabecode: {e.returncode}")
                    logging.error(f"[{job_id}] FFmpeg stderr:\n{e.stderr}")
                    status_callback(f"{error_msg} Details im Log.")
                    update_status(job_id, error=error_msg, running=False)
                    # Aufräumen: Lösche die (möglicherweise unvollständige) konvertierte Datei
                    if os.path.exists(converted_file_path):
                        try:
                            os.remove(converted_file_path)
                        except OSError:
                            pass
                    return None, None, None
                except Exception as e:
                    error_msg = f"Allgemeiner Fehler während der FFmpeg Konvertierung: {e}"
                    logging.exception(f"[{job_id}] {error_msg}") # Log traceback
                    status_callback(error_msg)
                    update_status(job_id, error=error_msg, running=False)
                    # --- KORREKTUR HIER ---
                    # Aufräumen
                    if os.path.exists(converted_file_path):
                        try: # Korrekt eingerückt
                            os.remove(converted_file_path)
                        except OSError: # Korrekt eingerückt
                            pass # Korrekt eingerückt
                    # --- ENDE KORREKTUR ---
                    return None, None, None

    except yt_dlp.utils.DownloadError as e:
        err_str = strip_ansi_codes(str(e))
        if "Unsupported URL" in err_str: error_msg = "Download-Fehler: Nicht unterstützte URL."
        elif "Video unavailable" in err_str: error_msg = "Download-Fehler: Video nicht verfügbar."
        elif "Private video" in err_str: error_msg = "Download-Fehler: Video ist privat."
        elif "HTTP Error 403" in err_str: error_msg = "Download-Fehler: Zugriff verweigert (403)."
        elif "HTTP Error 404" in err_str: error_msg = "Download-Fehler: Nicht gefunden (404)."
        elif "Login is required" in err_str or "age-restricted" in err_str:
             error_msg = "Download-Fehler: Inhalt erfordert Login oder ist altersbeschränkt."
             if not ydl_opts.get('cookiefile'): error_msg += " (Cookie-Datei nicht konfiguriert)"
             else: error_msg += " (Cookie-Datei möglicherweise ungültig/abgelaufen)"
        elif "InstagramLoginRequiredError" in err_str:
             error_msg = "Download-Fehler: Instagram erfordert Login für diesen Inhalt."
             if not ydl_opts.get('cookiefile'): error_msg += " (Cookie-Datei nicht konfiguriert)"
        elif "TwitterLoginRequiredError" in err_str:
             error_msg = "Download-Fehler: Twitter/X erfordert Login für diesen Inhalt."
             if not ydl_opts.get('cookiefile'): error_msg += " (Cookie-Datei nicht konfiguriert)"
        else: error_msg = f"Download-Fehler: {err_str[:200]}"
        status_callback(error_msg); logging.error(f"[{job_id}] Download-Fehler für {url}: {err_str}", exc_info=False)
        update_status(job_id, error=error_msg, running=False)
        return None, None, None
    except Exception as e:
        error_msg = f"Allgemeiner Fehler beim Download/Vorbereitung: {strip_ansi_codes(str(e))}"
        status_callback(error_msg); logging.exception(f"[{job_id}] {error_msg}") # Log traceback
        update_status(job_id, error=error_msg, running=False)
        return None, None, None

    if downloaded_file_path:
        _, final_extension_from_path = os.path.splitext(downloaded_file_path)
        final_extension = final_extension_from_path.lower()

    return downloaded_file_path, track_title, final_extension


# --- upload_to_s3 mit verbessertem Logging ---
def upload_to_s3(job_id, file_path, object_name, file_extension, bucket_name, aws_access_key_id, aws_secret_access_key, region_name, endpoint_url=None):
    status_callback = create_status_callback(job_id)
    logging.info(f"[{job_id}] Starte upload_to_s3 für Datei: {file_path}")

    if not file_path or not os.path.exists(file_path):
        error_msg = f"Upload-Fehler: Lokale Quelldatei nicht gefunden: '{file_path}'";
        status_callback(error_msg); logging.error(f"[{job_id}] {error_msg}")
        update_status(job_id, error=error_msg, running=False)
        return False

    content_type = 'application/octet-stream'; lowered_extension = file_extension.lower()
    if lowered_extension == '.mp4': content_type = 'video/mp4'
    elif lowered_extension == '.mp3': content_type = 'audio/mpeg'
    elif lowered_extension in ['.mov']: content_type = 'video/quicktime'
    elif lowered_extension in ['.avi']: content_type = 'video/x-msvideo'
    elif lowered_extension in ['.webm']: content_type = 'video/webm'

    provider = "AWS S3" if not endpoint_url else "S3-kompatiblen Speicher"
    status_callback(f"Starte Upload von '{os.path.basename(file_path)}' ({content_type}) zu {provider} Bucket '{bucket_name}' als '{object_name}'...")
    logging.info(f"[{job_id}] Upload Parameter: Bucket={bucket_name}, Key={object_name}, ContentType={content_type}, Endpoint={endpoint_url or 'Default'}")

    s3_client_args = { 'aws_access_key_id': aws_access_key_id, 'aws_secret_access_key': aws_secret_access_key, 'region_name': region_name }
    if endpoint_url: s3_client_args['endpoint_url'] = endpoint_url

    try:
        s3_client = boto3.client('s3', **s3_client_args)
        extra_args = {'ContentType': content_type}
        logging.info(f"[{job_id}] Rufe s3_client.upload_file auf...")
        response = s3_client.upload_file(file_path, bucket_name, object_name, ExtraArgs=extra_args)
        success_msg = f"Upload erfolgreich abgeschlossen!";
        status_callback(success_msg); logging.info(f"[{job_id}] {success_msg}")
        return True
    except NoCredentialsError:
        error_msg = "S3 Upload Fehler: AWS Credentials nicht gefunden oder ungültig.";
        status_callback(error_msg); logging.error(f"[{job_id}] {error_msg}")
        update_status(job_id, error=error_msg, running=False)
        return False
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', 'Unknown')
        error_message = e.response.get('Error', {}).get('Message', 'Keine Details')
        full_error = strip_ansi_codes(str(e))
        error_msg = f"S3 Client Fehler beim Upload (Code: {error_code}): {error_message}";
        status_callback(error_msg); logging.error(f"[{job_id}] {error_msg} - Volle Fehlermeldung: {full_error}", exc_info=False)
        update_status(job_id, error=error_msg, running=False)
        return False
    except Exception as e:
        error_msg = f"Allgemeiner Fehler beim S3 Upload: {strip_ansi_codes(str(e))}";
        status_callback(error_msg);
        logging.error(f"[{job_id}] {error_msg}", exc_info=True)
        update_status(job_id, error=error_msg, running=False)
        return False

# --- History Funktionen (Backend - unverändert) ---
def load_history():
    if not ENABLE_HISTORY: return []
    try:
        if os.path.exists(HISTORY_FILE):
            if os.path.getsize(HISTORY_FILE) == 0: logging.warning(f"{HISTORY_FILE} ist leer."); return []
            with open(HISTORY_FILE, 'r', encoding='utf-8') as f: history = json.load(f)
            return history if isinstance(history, list) else []
        else: return []
    except json.JSONDecodeError as e: logging.error(f"Fehler Laden History (JSON ungültig): {e}."); return []
    except Exception as e: logging.error(f"Fehler Laden History (Allgemein): {e}"); return []

def save_history(history_data):
    if not ENABLE_HISTORY: return True
    try:
        with open(HISTORY_FILE, 'w', encoding='utf-8') as f: json.dump(history_data, f, indent=4, ensure_ascii=False)
        logging.info(f"History gespeichert: {HISTORY_FILE}")
        return True
    except Exception as e: logging.error(f"Fehler Speichern History: {e}"); return False

def add_history_entry(platform, title, source_url, s3_url):
    if not ENABLE_HISTORY: return True
    history = load_history()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = {"timestamp": timestamp, "platform": platform, "title": title, "source_url": source_url, "s3_url": s3_url}
    history.insert(0, entry)
    return save_history(history)

def clear_history_file():
     if not ENABLE_HISTORY: return True
     try:
          if os.path.exists(HISTORY_FILE): os.remove(HISTORY_FILE); logging.info("History-Datei gelöscht.")
          return True
     except Exception as e: logging.error(f"Fehler Löschen History-Datei: {e}"); return False

# --- Statistik Funktionen (Backend - unverändert) ---
def load_stats():
    default_stats = {'total_jobs': 0, 'successful_jobs': 0, 'total_duration_seconds': 0.0, 'total_size_bytes': 0}
    try:
        if os.path.exists(STATS_FILE):
            if os.path.getsize(STATS_FILE) == 0: logging.warning(f"{STATS_FILE} ist leer."); return default_stats
            with open(STATS_FILE, 'r', encoding='utf-8') as f: stats = json.load(f)
            for key, default_value in default_stats.items():
                if key not in stats: stats[key] = default_value
            return stats
        else: return default_stats
    except json.JSONDecodeError as e: logging.error(f"Fehler Laden Statistik (JSON ungültig): {e}."); return default_stats
    except Exception as e: logging.error(f"Fehler Laden Statistik (Allgemein): {e}"); return default_stats

def save_stats(stats_data):
    try:
        with open(STATS_FILE, 'w', encoding='utf-8') as f: json.dump(stats_data, f, indent=4, ensure_ascii=False)
        return True
    except Exception as e: logging.error(f"Fehler Speichern Statistik: {e}"); return False

def update_stats(duration_seconds, file_size_bytes, success):
    stats = load_stats()
    stats['total_jobs'] = stats.get('total_jobs', 0) + 1
    if success:
        stats['successful_jobs'] = stats.get('successful_jobs', 0) + 1
        stats['total_duration_seconds'] = stats.get('total_duration_seconds', 0.0) + duration_seconds
        stats['total_size_bytes'] = stats.get('total_size_bytes', 0) + file_size_bytes
    save_stats(stats)

# --- Haupt-Verarbeitungsfunktion mit verbessertem Logging/Error Handling ---
def run_download_upload_task(job_id, url, platform, format_preference, mp3_bitrate, mp4_quality,
                               codec_preference, access_key, secret_key, bucket_name, region_name, endpoint_url):
    start_time = time.time()
    downloaded_file = None; track_title = None; file_extension = None
    s3_object_name = None; public_url = None; s3_client = None
    process_ok = False # Wird nur True, wenn *alles* klappt
    final_error_message = None
    file_size_bytes = 0

    update_status(job_id, message="Starte Verarbeitung...", running=True, status_code="running")
    logging.info(f"[{job_id}] Worker startet Task für URL: {url}")

    try:
        # --- Download Phase ---
        logging.info(f"[{job_id}] Starte Download-Phase...")
        downloaded_file, track_title, file_extension = download_track(
            job_id, url, platform, format_preference, mp3_bitrate, mp4_quality, codec_preference, DOWNLOAD_DIR)

        with task_lock:
            job_failed_during_download = job_statuses.get(job_id, {}).get("error") is not None

        if job_failed_during_download:
            logging.error(f"[{job_id}] Fehler während Download/Konvertierung erkannt. Breche Verarbeitung ab.")
        elif not (downloaded_file and track_title and file_extension):
             final_error_message = "Download/Konvertierung fehlgeschlagen (unerwarteter Zustand)."
             logging.error(f"[{job_id}] {final_error_message}")
             update_status(job_id, error=final_error_message, running=False)
        else:
            # --- Upload Phase (nur wenn Download OK) ---
            logging.info(f"[{job_id}] Download erfolgreich: {downloaded_file}. Starte Upload-Phase...")
            try:
                if os.path.exists(downloaded_file):
                    file_size_bytes = os.path.getsize(downloaded_file)
                    logging.info(f"[{job_id}] Dateigröße: {format_size(file_size_bytes)}")
                else:
                    logging.warning(f"[{job_id}] Heruntergeladene Datei {downloaded_file} existiert nicht mehr vor dem Upload?")
            except OSError as size_e:
                logging.warning(f"[{job_id}] Konnte Dateigröße nicht ermitteln: {size_e}")

            update_status(job_id, message="Verbinde mit S3 Speicher...")
            s3_client_args = { 'aws_access_key_id': access_key, 'aws_secret_access_key': secret_key, 'region_name': region_name }
            if endpoint_url: s3_client_args['endpoint_url'] = endpoint_url
            try:
                s3_client = boto3.client('s3', **s3_client_args)
                logging.info(f"[{job_id}] S3 Client erfolgreich erstellt.")
            except Exception as client_e:
                final_error_message = f"Fehler bei S3 Client Erstellung: {client_e}"
                logging.error(f"[{job_id}] {final_error_message}", exc_info=True)
                update_status(job_id, error=final_error_message, running=False)
                raise

            update_status(job_id, message=f"Generiere eindeutigen S3 Dateinamen mit Endung '{file_extension}'...")
            unique_name_found = False
            for attempt in range(MAX_FILENAME_RETRIES):
                candidate_name = generate_s3_object_name(file_extension)
                logging.debug(f"[{job_id}] Prüfe S3 Name (Versuch {attempt+1}/{MAX_FILENAME_RETRIES}): {candidate_name}")
                try:
                    s3_client.head_object(Bucket=bucket_name, Key=candidate_name)
                    logging.warning(f"[{job_id}] S3 Name '{candidate_name}' existiert bereits.")
                except ClientError as e:
                    if e.response['Error']['Code'] in ['404', 'NoSuchKey', 'NotFound']:
                        s3_object_name = candidate_name; unique_name_found = True
                        logging.info(f"[{job_id}] Eindeutiger S3 Name gefunden: {s3_object_name}")
                        break
                    else:
                        final_error_message = f"S3 Fehler bei Namensprüfung ({candidate_name}): {e}"
                        logging.error(f"[{job_id}] {final_error_message}", exc_info=True)
                        update_status(job_id, error=final_error_message, running=False)
                        raise
                except Exception as head_e:
                    final_error_message = f"Allgemeiner Fehler bei S3 Namensprüfung ({candidate_name}): {head_e}"
                    logging.error(f"[{job_id}] {final_error_message}", exc_info=True)
                    update_status(job_id, error=final_error_message, running=False)
                    raise

            if not unique_name_found:
                final_error_message = f"Konnte keinen eindeutigen S3 Namen nach {MAX_FILENAME_RETRIES} Versuchen finden."
                logging.error(f"[{job_id}] {final_error_message}")
                update_status(job_id, error=final_error_message, running=False)
            else:
                update_status(job_id, message="Starte Upload...", progress=50)
                logging.info(f"[{job_id}] Rufe upload_to_s3 auf für Datei '{downloaded_file}' nach '{bucket_name}/{s3_object_name}'")
                upload_success = upload_to_s3(
                    job_id, downloaded_file, s3_object_name, file_extension, bucket_name,
                    access_key, secret_key, region_name, endpoint_url
                )
                logging.info(f"[{job_id}] upload_to_s3 Aufruf beendet. Erfolg: {upload_success}")

                with task_lock:
                    job_failed_during_upload = job_statuses.get(job_id, {}).get("error") is not None

                if job_failed_during_upload:
                     logging.error(f"[{job_id}] Fehler während Upload erkannt. Breche Verarbeitung ab.")
                elif not upload_success:
                     final_error_message = "Upload fehlgeschlagen (unerwarteter Zustand)."
                     logging.error(f"[{job_id}] {final_error_message}")
                     update_status(job_id, error=final_error_message, running=False)
                else:
                    logging.info(f"[{job_id}] Upload erfolgreich.")
                    update_status(job_id, message="Upload erfolgreich!", progress=100)
                    process_ok = True
                    final_s3_url_for_history = f"s3://{bucket_name}/{s3_object_name}"
                    s3_public_url_base = os.getenv('S3_PUBLIC_URL_BASE')
                    if s3_public_url_base:
                        safe_object_name = urllib.parse.quote(s3_object_name)
                        public_url = s3_public_url_base.rstrip('/') + '/' + safe_object_name
                        update_status(job_id, result_url=public_url, message="Abgeschlossen!")
                        final_s3_url_for_history = public_url
                        logging.info(f"[{job_id}] Datei öffentlich erreichbar unter: {public_url}")
                    else:
                        update_status(job_id, message="Abgeschlossen! (Keine Public URL Base konfiguriert)")
                        logging.warning(f"[{job_id}] Öffentliche URL kann nicht angezeigt werden (S3_PUBLIC_URL_BASE fehlt).")

                    if not add_history_entry(platform, track_title, url, final_s3_url_for_history):
                         logging.warning(f"[{job_id}] Konnte Eintrag nicht zur History hinzufügen.")
                         update_status(job_id, log_entry="WARNUNG: Konnte Eintrag nicht zur History hinzufügen.")

    except Exception as e:
        logging.exception(f"[{job_id}] Unerwarteter Fehler im Hauptverarbeitungsblock für URL {url}:")
        final_error_message = f"Unerwarteter Verarbeitungsfehler: {strip_ansi_codes(str(e))}"
        try:
            with task_lock:
                if job_id in job_statuses and not job_statuses[job_id].get("error"):
                     update_status(job_id, error=final_error_message, running=False)
        except Exception as inner_e:
             logging.error(f"[{job_id}] Kritischer Fehler: Konnte Fehlerstatus nach Hauptfehler nicht setzen: {inner_e}")
        process_ok = False

    finally:
        end_time = time.time()
        duration = end_time - start_time
        final_status_to_set = None
        job_success_status = 'FEHLER'

        try:
            with task_lock:
                # Stelle sicher, dass der Job noch existiert, bevor darauf zugegriffen wird
                if job_id in job_statuses:
                    current_job_status = job_statuses.get(job_id, {})
                    if current_job_status.get("error"):
                        final_status_to_set = "error"
                        job_success_status = 'FEHLER'
                        process_ok = False
                    elif process_ok:
                         final_status_to_set = "completed"
                         job_success_status = 'OK'
                    else:
                        final_status_to_set = "error"
                        job_success_status = 'FEHLER'
                        if not current_job_status.get("error"):
                            logging.warning(f"[{job_id}] Prozess nicht erfolgreich, aber kein expliziter Fehler gesetzt. Setze Status auf 'error'.")
                            error_msg_fallback = "Verarbeitung fehlgeschlagen (Grund unklar)."
                            current_job_status_dict = dict(current_job_status)
                            current_job_status_dict["error"] = error_msg_fallback
                            current_job_status_dict["message"] = f"Fehler: {error_msg_fallback}"
                            current_job_status_dict["status"] = "error"
                            current_job_status_dict["running"] = False
                            job_statuses[job_id] = current_job_status_dict
                else:
                     logging.warning(f"[{job_id}] Job nicht mehr in job_statuses im finally-Block.")
                     # Kein Status kann mehr gesetzt werden

            # Setze finalen Status und running=False nur, wenn Job noch existiert
            if job_id in job_statuses:
                 update_status(job_id, status_code=final_status_to_set, running=False)

        except Exception as final_status_e:
             logging.exception(f"[{job_id}] Fehler beim Setzen des finalen Job-Status:")
             try:
                 if job_id in job_statuses: update_status(job_id, running=False)
             except: pass

        logging.info(f"Worker-Task für Job {job_id} (URL {url}) beendet. Status: {job_success_status}, Dauer: {duration:.2f}s")

        try:
            actual_file_size = file_size_bytes if process_ok else 0
            update_stats(duration, actual_file_size, process_ok)
        except Exception as stats_e:
             logging.error(f"[{job_id}] Fehler beim Aktualisieren der Statistik: {stats_e}")

        if downloaded_file and os.path.exists(downloaded_file):
             try:
                  logging.info(f"[{job_id}] Versuche, lokale Datei zu löschen: {downloaded_file}")
                  os.remove(downloaded_file)
                  logging.info(f"[{job_id}] Temporäre lokale Datei '{os.path.basename(downloaded_file)}' erfolgreich gelöscht.")
                  if process_ok and job_id in job_statuses:
                      try: update_status(job_id, log_entry=f"Lokale Datei '{os.path.basename(downloaded_file)}' aufgeräumt.")
                      except: pass
             except OSError as e:
                  logging.error(f"[{job_id}] Fehler beim Löschen der temporären Datei '{os.path.basename(downloaded_file)}': {e}")
                  if job_id in job_statuses:
                      try: update_status(job_id, log_entry=f"WARNUNG: Lokale Datei nicht gelöscht: {e}")
                      except: pass
             except Exception as cleanup_e:
                  logging.exception(f"[{job_id}] Unerwarteter Fehler beim Aufräumen der Datei {downloaded_file}:")
                  if job_id in job_statuses:
                      try: update_status(job_id, log_entry=f"WARNUNG: Fehler beim Datei-Cleanup: {cleanup_e}")
                      except: pass


# --- Worker Thread Funktion (unverändert) ---
def worker_thread_target():
    logging.info(f"Worker-Thread {threading.current_thread().name} gestartet und wartet auf Tasks...")
    while True:
        task_data = None
        current_job_id = None
        try:
            task_data = task_queue.get()
            current_job_id = task_data[0]
            task_args = task_data[1:]
            logging.info(f"Worker {threading.current_thread().name} holt neuen Task [{current_job_id}] aus der Queue für URL: {task_args[0][:50]}...")
            run_download_upload_task(current_job_id, *task_args)
            logging.info(f"Worker {threading.current_thread().name} hat Task [{current_job_id}] beendet.")
        except Exception as e:
            logging.exception(f"Schwerwiegender Fehler im Worker-Thread {threading.current_thread().name} für Job {current_job_id}:")
            try:
                if current_job_id:
                    error_msg = f"Schwerer Worker-Fehler: {e}"
                    with task_lock:
                        if current_job_id in job_statuses and not job_statuses[current_job_id].get("error"):
                            update_status(current_job_id, error=error_msg, running=False, status_code="error")
                        elif current_job_id in job_statuses:
                             update_status(current_job_id, running=False)
                else:
                    logging.error("Konnte Job-Status nach schwerem Worker-Fehler nicht aktualisieren (keine Job-ID).")
            except Exception as inner_e:
                logging.error(f"Konnte Job-Status nach schwerem Worker-Fehler nicht aktualisieren: {inner_e}")
            time.sleep(5)


# --- Flask Routen ---
@app.route('/')
def index():
    global job_statuses
    if not isinstance(job_statuses, type(manager.dict())):
        job_statuses = manager.dict()
        logging.warning("job_statuses wurde neu initialisiert (wahrscheinlich nach Reload).")
    return render_template('index.html', history_enabled=ENABLE_HISTORY)

@app.route('/start_download', methods=['POST'])
def start_download():
    # (Logik unverändert)
    url = request.form.get('url'); platform = request.form.get('platform', DEFAULT_PLATFORM)
    yt_format = request.form.get('yt_format', DEFAULT_YT_FORMAT); mp3_bitrate = request.form.get('mp3_bitrate', DEFAULT_MP3_BITRATE)
    mp4_quality = request.form.get('mp4_quality', DEFAULT_MP4_QUALITY)
    codec_preference = request.form.get('codec_preference', 'original')

    is_valid_url = False
    if url and url.startswith(("http://", "https://")):
        parsed_url = urllib.parse.urlparse(url)
        domain = parsed_url.netloc.lower()
        path = parsed_url.path.lower()
        if platform == "SoundCloud" and "soundcloud.com" in domain: is_valid_url = True
        elif platform == "YouTube" and ("youtube.com" in domain or "youtu.be" in domain): is_valid_url = True
        elif platform == "TikTok" and "tiktok.com" in domain: is_valid_url = True
        elif platform == "Instagram" and "instagram.com" in domain and ("/reel/" in path or "/p/" in path): is_valid_url = True
        elif platform == "Twitter" and ("twitter.com" in domain or "x.com" in domain) and "/status/" in path: is_valid_url = True
        elif platform not in SUPPORTED_PLATFORMS:
             logging.warning(f"Unbekannte Plattform '{platform}' angegeben, versuche trotzdem mit URL '{url}'")
             is_valid_url = True

    if not is_valid_url:
        error_msg = f"Ungültige URL für {platform}."
        if platform == "Instagram": error_msg += " Stelle sicher, dass es ein Reel- oder Post-Link ist (enthält /reel/ oder /p/)."
        if platform == "Twitter": error_msg += " Stelle sicher, dass es ein Tweet-Link ist (enthält /status/)."
        return jsonify({"error": error_msg}), 400

    if ENABLE_HISTORY:
        history = load_history()
        for entry in history:
            entry_url = entry.get('source_url') or entry.get('soundcloud_url')
            if entry_url == url:
                entry_platform = entry.get('platform', 'Unbekannt')
                return jsonify({"error": f"Dieser Link ({entry_platform}) wurde bereits verarbeitet (Verlauf aktiv)."}), 400

    access_key = os.getenv('AWS_ACCESS_KEY_ID'); secret_key = os.getenv('AWS_SECRET_ACCESS_KEY')
    bucket_name = os.getenv('AWS_S3_BUCKET_NAME'); region_name = os.getenv('AWS_REGION')
    endpoint_url = os.getenv('S3_ENDPOINT_URL')
    if not (access_key and secret_key and bucket_name): return jsonify({"error": "S3 Konfiguration in .env unvollständig."}), 500

    job_id = str(uuid.uuid4())
    task_args = (url, platform, yt_format, mp3_bitrate, mp4_quality, codec_preference,
                 access_key, secret_key, bucket_name, region_name, endpoint_url)

    with task_lock:
        job_statuses[job_id] = {
            "running": False, "message": "In Warteschlange...", "progress": 0.0,
            "logs": [f"{datetime.now().strftime('%H:%M:%S')} - Auftrag eingereiht."],
            "error": None, "result_url": None, "start_time": time.time(),
            "last_update": time.time(), "status": "queued"
        }

    task_queue.put((job_id,) + task_args)
    logging.info(f"Neuer Task [{job_id}] zur Queue hinzugefügt für {url}.")

    return jsonify({"message": f"Auftrag eingereiht.", "job_id": job_id}), 202

@app.route('/status')
def get_status():
    job_id = request.args.get('job_id')
    if not job_id:
        return jsonify({"error": "Job ID fehlt.", "running": False, "status": "error"}), 400

    with task_lock:
        if job_id not in job_statuses:
             return jsonify({"error": "Job nicht gefunden oder bereits aufgeräumt.", "running": False, "status": "not_found"}), 404
        current_status_copy = dict(job_statuses[job_id])
        if current_status_copy.get("status") == "queued":
            position = 1
            total_queued = 0
            current_job_start_time = current_status_copy.get("start_time", 0)
            all_job_ids = list(job_statuses.keys())
            for other_job_id in all_job_ids:
                other_status = job_statuses.get(other_job_id)
                if other_status and other_status.get("status") == "queued":
                    total_queued += 1
                    if other_job_id != job_id and other_status.get("start_time", 0) < current_job_start_time:
                        position += 1
            current_status_copy["position"] = position
            current_status_copy["total_queued"] = total_queued
        current_status_copy.pop("queue_size", None)
        if "logs" in current_status_copy and not isinstance(current_status_copy["logs"], list):
             current_status_copy["logs"] = list(current_status_copy["logs"])
        return jsonify(current_status_copy)

@app.route('/history')
def get_history():
    history = load_history()
    return jsonify(history)

@app.route('/clear_history', methods=['POST'])
def clear_history_route():
    if clear_history_file():
        return jsonify({"message": "Verlauf gelöscht (falls aktiviert)."}), 200
    else:
        return jsonify({"error": "Fehler beim Löschen des Verlaufs."}), 500

@app.route('/stats')
def get_stats():
    stats_data = load_stats()
    avg_duration = 0.0
    if stats_data.get('successful_jobs', 0) > 0:
        avg_duration = stats_data.get('total_duration_seconds', 0.0) / stats_data['successful_jobs']
    formatted_stats = {
        "total_jobs": stats_data.get('total_jobs', 0),
        "successful_jobs": stats_data.get('successful_jobs', 0),
        "average_duration_seconds": round(avg_duration, 2),
        "total_size_formatted": format_size(stats_data.get('total_size_bytes', 0))
    }
    return jsonify(formatted_stats)

# --- Cleanup Funktion (leicht angepasst für Manager Dict) ---
def cleanup_old_jobs():
    logging.info("Job Status Cleanup Thread gestartet.")
    while True:
        time.sleep(60)
        now = time.time()
        jobs_to_remove = []
        try:
            current_job_ids = list(job_statuses.keys())
            for job_id in current_job_ids:
                status = job_statuses.get(job_id)
                if not status: continue
                is_running = status.get("running", False)
                last_update = status.get("last_update", 0)
                is_queued_long_time = status.get("status") == "queued" and (now - status.get("start_time", 0)) > (JOB_STATUS_TTL_SECONDS * 2)
                if (not is_running and (now - last_update) > JOB_STATUS_TTL_SECONDS) or is_queued_long_time:
                    if is_queued_long_time:
                         logging.warning(f"Räume sehr alten 'queued' Job {job_id} auf (möglicherweise hängt der Worker).")
                    jobs_to_remove.append(job_id)
            if jobs_to_remove:
                logging.info(f"Räume {len(jobs_to_remove)} alte Job-Status auf: {', '.join(jobs_to_remove)}")
                for job_id in jobs_to_remove:
                    job_statuses.pop(job_id, None)
        except Exception as e:
            logging.error(f"Fehler im Cleanup Thread: {e}", exc_info=True)

# --- Globaler Thread-Start für Gunicorn (unverändert) ---
_threads_started_globally = False
_background_threads = []

def start_background_threads():
    global _threads_started_globally, _background_threads
    if _threads_started_globally:
        all_running = True
        for t in _background_threads:
            if not t.is_alive():
                all_running = False
                logging.warning(f"Hintergrund-Thread {t.name} lief nicht mehr.")
        if all_running and _background_threads:
             logging.info("Hintergrund-Threads wurden bereits global gestartet und laufen noch.")
             return
        else:
             logging.warning("Einige Hintergrund-Threads liefen nicht mehr oder Liste war leer. Starte neu.")
             _threads_started_globally = False
             _background_threads = []

    logging.info("Starte Hintergrund-Threads global...")
    print(f"--> Starte {MAX_WORKERS} Worker-Thread(s) global...")
    for i in range(MAX_WORKERS):
        worker = threading.Thread(target=worker_thread_target, daemon=True, name=f"BGWorker-{i+1}")
        worker.start()
        _background_threads.append(worker)
        print(f"--> Worker {i+1} gestartet.")

    print("--> Starte Job Status Cleanup Thread global...")
    cleanup = threading.Thread(target=cleanup_old_jobs, daemon=True, name="CleanupThread")
    cleanup.start()
    _background_threads.append(cleanup)

    _threads_started_globally = True
    logging.info(f"Hintergrund-Threads global gestartet ({len(_background_threads)} Threads).")

start_background_threads()

# --- Hauptprogramm (nur für lokale Entwicklung mit `python app.py`) ---
if __name__ == '__main__':
    import shutil
    if shutil.which("ffmpeg") is None: print("\nWARNUNG: FFmpeg nicht im PATH gefunden (innerhalb Containers OK).\n")
    else: print("\nINFO: FFmpeg gefunden.\n")
    print(f"\nFlask App startet (lokaler Modus)...");
    print(f"Download-Verzeichnis: {DOWNLOAD_DIR}")
    print(f"Verlauf aktiviert: {ENABLE_HISTORY}")
    print(f"Öffne http://127.0.0.1:5000 oder http://<Deine-IP>:5000 im Browser.")
    print("(Beende mit STRG+C)\n")
    app.run(debug=False, host='0.0.0.0', port=5000, use_reloader=False)