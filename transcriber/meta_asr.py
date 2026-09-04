"""
Client de reconnaissance vocale Meta — transport WebSocket temps réel.

Ce module ne connaît rien du reste du service : il reçoit du PCM et rappelle
deux fonctions, une pour les hypothèses, une pour les phrases confirmées. Toute
la chaîne amont — DirectTransport, dépaquetage RTP, tampon de gigue, décodage
Opus, rééchantillonnage — reste identique à ce qu'elle était avec sherpa-onnx.

TROIS PARTICULARITÉS DE CETTE API, qui expliquent la forme du code :

1. L'AUTHENTIFICATION NE PASSE PAS PAR UN EN-TÊTE HTTP. La clé va dans le
   premier message, celui de poignée de main, sous `authorization.accessToken`.
   Un `Authorization:` classique serait ignoré en silence — donc une connexion
   qui s'ouvre puis ne renvoie jamais rien.

2. UNE SESSION EST PLAFONNÉE À 60 MINUTES. Nos flux se ferment après 30 s de
   silence, mais quelqu'un qui reprend la parole toutes les vingt secondes
   pendant une réunion longue garde la connexion ouverte. On la renouvelle donc
   avant la limite plutôt que d'attendre qu'elle tombe en pleine phrase.

3. LE COMPTE EST PLAFONNÉ À 8 FLUX SIMULTANÉS, toutes réunions confondues. Ce
   n'est pas géré ici mais côté mediasoup, qui décide à qui attribuer une place.

⚠️ Le schéma exact des événements reçus n'est pas entièrement spécifié dans la
documentation. Le parseur est donc volontairement tolérant, et le premier
événement inconnu est journalisé en entier — c'est ce qui permettra d'ajuster
en une ligne plutôt que de deviner.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections import deque

import numpy as np

log = logging.getLogger("transcriber.meta")

# ── Réglages ────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("META_API_KEY", "")
WS_URL = os.environ.get("META_WS_URL", "wss://api.meta.ai/v1/asr/realtime")
MODEL = os.environ.get("META_MODEL", "muse-voice-transcribe-1.0")

# ENDPOINTING : le service découpe lui-même en phrases, ce que faisait
# l'endpointing du transducteur. DIARIZATION ne nous sert à rien — mediasoup
# nous donne déjà un flux par personne, donc une attribution exacte plutôt que
# devinée à l'oreille.
MODE = os.environ.get("META_MODE", "ENDPOINTING")

# CUMULATIVE renvoie le texte complet du segment en cours, exactement la
# sémantique de `get_result` : l'affichage à deux niveaux, gris puis noir,
# fonctionne sans rien changer côté navigateur.
PARTIAL_MODE = os.environ.get("META_PARTIAL_MODE", "CUMULATIVE")

LANGUAGE = os.environ.get("META_LANGUAGE", "fr")
TARGET_RATE = 16000

# Renouvellement anticipé, sous la limite de 60 minutes de l'API.
SESSION_MAX_S = float(os.environ.get("META_SESSION_MAX_S", "3300"))

CONNECT_TIMEOUT_S = float(os.environ.get("META_CONNECT_TIMEOUT_S", "10"))
RECONNECT_DELAY_S = float(os.environ.get("META_RECONNECT_DELAY_S", "1.0"))
MAX_RECONNECTS = int(os.environ.get("META_MAX_RECONNECTS", "5"))

# Audio conservé pendant une coupure, pour être renvoyé à la reconnexion. Deux
# secondes suffisent : au-delà, mieux vaut un trou qu'un décalage permanent.
BACKLOG_S = float(os.environ.get("META_BACKLOG_S", "2.0"))

# Journalise les N premiers événements reçus, en entier. Le schéma exact n'étant
# pas spécifié dans la documentation, c'est le seul moyen de le constater plutôt
# que de le supposer. Mettre 0 en usage normal.
DEBUG_EVENTS = int(os.environ.get("META_DEBUG_EVENTS", "0"))


def available() -> bool:
    """Le moteur est-il utilisable ? Sans clé, inutile d'essayer."""
    return bool(API_KEY)


class MetaSession:
    """
    Une connexion pour un locuteur. Chaque instance vit dans le fil de travail
    de sa session et n'est jamais partagée.
    """

    def __init__(self, speaker_name, keywords, on_partial, on_final):
        self.speaker_name = speaker_name
        self.keywords = [k for k in (keywords or []) if k and k.strip()]
        self.on_partial = on_partial
        self.on_final = on_final

        self._ws = None
        self._reader = None
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._opened_at = 0.0
        self._backlog = deque()
        self._backlog_bytes = 0
        self._unknown_logged = False
        self._debug_left = DEBUG_EVENTS

        self.reconnects = 0
        self.renewals = 0
        self.sent_bytes = 0
        self.errors = 0

    # ── Connexion ───────────────────────────────────────────────────────────

    def _handshake(self):
        payload = {
            # La clé va ICI, pas dans un en-tête HTTP.
            "authorization": {"accessToken": "Bearer " + API_KEY},
            "audioEncoding": "PCM_16KHZ",
            "model": MODEL,
            "mode": MODE,
            "partialMode": PARTIAL_MODE,
        }
        if LANGUAGE:
            payload["languageBias"] = [LANGUAGE]
        if self.keywords:
            # Même rôle que les `hotwords` de sherpa-onnx : le nom du locuteur
            # est ce que tout modèle écorche le plus, et on le connaît.
            payload["keywords"] = self.keywords
        return payload

    def connect(self):
        """Ouvre la connexion et lance le fil de réception. False si échec."""
        import websocket  # dépendance chargée seulement si ce moteur sert

        url = WS_URL + "?sessionId=" + str(uuid.uuid4())
        try:
            ws = websocket.create_connection(url, timeout=CONNECT_TIMEOUT_S)
            ws.send(json.dumps(self._handshake()))
        except Exception as error:
            self.errors += 1
            log.warning("Connexion Meta impossible · %s : %s", self.speaker_name, error)
            return False

        with self._lock:
            self._ws = ws
            self._opened_at = time.monotonic()

        self._reader = threading.Thread(target=self._receive_loop, args=(ws,), daemon=True)
        self._reader.start()
        log.info("Session Meta ouverte · %s", self.speaker_name)
        return True

    def _reconnect(self):
        if self._closed.is_set() or self.reconnects >= MAX_RECONNECTS:
            return False
        self.reconnects += 1
        log.warning(
            "Reconnexion Meta · %s · %d/%d",
            self.speaker_name, self.reconnects, MAX_RECONNECTS,
        )
        self._drop()
        time.sleep(RECONNECT_DELAY_S)
        if not self.connect():
            return False
        self._flush_backlog()
        return True

    def _renew(self):
        """
        Renouvelle la session avant les 60 minutes imposées par l'API.

        Sans ça, la connexion tomberait d'elle-même en pleine phrase, et la
        personne cesserait d'être transcrite sans que rien ne le signale.
        """
        self.renewals += 1
        log.info("Renouvellement de session Meta · %s", self.speaker_name)
        self._drop()
        if self.connect():
            self._flush_backlog()

    def _drop(self):
        with self._lock:
            ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    # ── Émission ────────────────────────────────────────────────────────────

    def feed(self, samples):
        """Envoie du PCM 16 kHz float32. Ne lève jamais."""
        if self._closed.is_set() or not len(samples):
            return

        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()

        if self._opened_at and time.monotonic() - self._opened_at > SESSION_MAX_S:
            self._renew()

        with self._lock:
            ws = self._ws

        if ws is None:
            self._remember(pcm)
            self._reconnect()
            return

        try:
            ws.send_binary(pcm)
            self.sent_bytes += len(pcm)
        except Exception as error:
            self.errors += 1
            log.warning("Envoi Meta interrompu · %s : %s", self.speaker_name, error)
            self._remember(pcm)
            self._reconnect()

    def _remember(self, pcm):
        """Garde le son d'une coupure, borné — mieux vaut un trou qu'un retard."""
        limit = int(BACKLOG_S * TARGET_RATE) * 2
        self._backlog.append(pcm)
        self._backlog_bytes += len(pcm)
        while self._backlog_bytes > limit and self._backlog:
            self._backlog_bytes -= len(self._backlog.popleft())

    def _flush_backlog(self):
        with self._lock:
            ws = self._ws
        if ws is None:
            return
        while self._backlog:
            chunk = self._backlog.popleft()
            self._backlog_bytes -= len(chunk)
            try:
                ws.send_binary(chunk)
            except Exception:
                self._remember(chunk)
                return

    # ── Réception ───────────────────────────────────────────────────────────

    def _receive_loop(self, ws):
        while not self._closed.is_set():
            try:
                message = ws.recv()
            except Exception:
                break
            if not message:
                break
            if isinstance(message, bytes):
                continue
            try:
                self._handle(json.loads(message))
            except Exception as error:
                self.errors += 1
                log.warning("Événement Meta illisible · %s : %s", self.speaker_name, error)

    def _handle(self, event):
        """
        Route un événement vers les rappels.

        ⚠️ L'ordre compte, et la première version s'y est trompée. On extrait le
        texte AVANT de filtrer par type d'événement : un `speechComplete` était
        écarté d'office comme simple fin de tour, alors que c'est lui qui portait
        la phrase définitive. Résultat, tout restait en hypothèse grise et rien
        ne se figeait jamais à l'écran.

        La règle est donc : tout événement porteur de texte est publié, et seul
        le caractère définitif se déduit des drapeaux.
        """
        if self._debug_left > 0:
            self._debug_left -= 1
            log.info("Événement Meta brut : %s", event)

        kind = (event.get("type") or event.get("event") or "").lower()

        text = (
            event.get("text")
            or event.get("transcript")
            or (event.get("result") or {}).get("text")
            or ""
        )
        text = text.strip() if isinstance(text, str) else ""

        if not text:
            # Événement de contrôle sans texte : rien à publier.
            if kind not in ("speechstart", "speechend", "audioprogress", "speaker",
                            "speechcomplete", "ready", "ack") and not self._unknown_logged:
                self._unknown_logged = True
                log.info("Événement Meta non reconnu (premier seulement) : %s", event)
            return

        final = bool(
            event.get("isFinal")
            or event.get("final")
            or event.get("stability") == "FINAL"
            or "final" in kind
            or "complete" in kind
            # Certaines API signalent l'inverse : un partiel explicitement faux.
            or event.get("isPartial") is False
            or event.get("partial") is False
        )
        (self.on_final if final else self.on_partial)(text)

    # ── Fermeture ───────────────────────────────────────────────────────────

    def close(self):
        self._closed.set()
        self._drop()

    def stats(self):
        return {
            "sentSeconds": round(self.sent_bytes / (TARGET_RATE * 2), 1),
            "reconnects": self.reconnects,
            "renewals": self.renewals,
            "errors": self.errors,
            "connected": self._ws is not None,
        }
