"""
Service de transcription en flux — architecture v2.

Remplace entièrement la chaîne précédente (PlainTransport UDP → ffmpeg → VAD
Silero → Whisper) par un chemin direct :

    mediasoup DirectTransport
        → WebSocket binaire (paquets RTP bruts)
        → dépaquetage + tampon de gigue
        → décodage Opus (libopus, avec dissimulation de perte)
        → rééchantillonnage 48 → 16 kHz
        → sherpa-onnx, transducteur causal

CE QUI CHANGE, ET POURQUOI :

1. PLUS DE ffmpeg. Le décodage se fait en bibliothèque, dans le processus. On
   supprime du même coup le sous-processus, les ports UDP, le fichier SDP et
   surtout le mode de panne qui a coûté le plus cher : ffmpeg abandonnant sur
   un délai réseau sans que rien ne le relance.

2. PLUS DE VAD À SEUIL. Le transducteur décide lui-même de la fin d'une phrase,
   sur un critère linguistique — il émet des jetons vides — et non sur un seuil
   d'énergie empirique. Le réglage « 1,0 s de silence » disparaît.

3. MODÈLE CAUSAL. Whisper devait attendre la fin d'une phrase puis réanalyser
   une fenêtre complète, d'où 10 à 13 s avant le premier mot. Ici le texte sort
   pendant que la personne parle : mesuré à 1,4 s sur cette machine.

CE QUI RESTE À NOTRE CHARGE, et que ffmpeg faisait en silence : le désordre des
paquets, les pertes, la continuité temporelle et le rééchantillonnage. C'est
l'essentiel du code ci-dessous.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import threading
import time
from dataclasses import dataclass, field

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("streaming")

# ── Réglages ────────────────────────────────────────────────────────────────

MODEL_DIR = os.environ.get("SHERPA_MODEL_DIR", "/models/sherpa-fr")
NUM_THREADS = int(os.environ.get("SHERPA_THREADS", "2"))
DECODING = os.environ.get("SHERPA_DECODING", "greedy_search")

# Endpointing du transducteur. Ces trois règles remplacent le seuil de silence
# du VAD : la première clôt sur un long silence, la deuxième sur un silence plus
# court APRÈS avoir décodé quelque chose, la troisième borne les monologues.
RULE1_SILENCE = float(os.environ.get("SHERPA_RULE1", "2.4"))
RULE2_SILENCE = float(os.environ.get("SHERPA_RULE2", "1.0"))
RULE3_MAX_FRAMES = int(os.environ.get("SHERPA_RULE3", "300"))

OPUS_RATE = 48000
TARGET_RATE = 16000
# Trame Opus la plus longue autorisée par la norme, à 48 kHz. libopus a besoin
# d'un tampon dimensionné pour le pire cas, pas pour le cas courant de 20 ms.
MAX_FRAME_SAMPLES = 5760
FRAME_SAMPLES_20MS = 960

# Fenêtre de réordonnancement, en paquets. Trois trames de 20 ms couvrent la
# gigue habituelle d'un réseau domestique sans ajouter de latence perceptible.
#
# ⚠️ Le désordre à corriger vient d'AVANT mediasoup : le WebSocket, en TCP,
# préserve l'ordre d'émission. C'est donc bien ici, et nulle part ailleurs, que
# le tri doit se faire.
REORDER_WINDOW = int(os.environ.get("REORDER_WINDOW", "3"))

# Silence maximal reconstruit d'un coup. Au-delà, on considère que le locuteur
# s'est tu longuement (DTX ou micro coupé) et on repart proprement plutôt que
# d'injecter des minutes de zéros dans le modèle.
MAX_GAP_S = float(os.environ.get("MAX_GAP_S", "2.0"))

# Cadence maximale d'émission des hypothèses. `get_result` renvoie le texte
# complet du segment en cours à CHAQUE trame : sans limitation, on enverrait
# cinquante messages par seconde et par locuteur, contenant presque toujours la
# même chose.
PARTIAL_INTERVAL_S = float(os.environ.get("PARTIAL_INTERVAL_S", "0.25"))

DUMP_WAV_DIR = os.environ.get("DUMP_WAV_DIR", "")

# ── Correction par LLM — architecture à deux vitesses ───────────────────────
#
# Vitesse 1 : l'hypothèse part telle qu'entendue, sans aucun traitement.
# Vitesse 2 : la phrase confirmée est corrigée en tâche de fond pendant que le
#             transducteur écoute déjà la suivante.
#
# ⚠️ La règle absolue est qu'aucun appel au LLM ne doit être attendu sur le
# chemin de l'audio. Un LLM met plusieurs secondes ; pendant ce temps les paquets
# RTP s'accumuleraient et le décalage deviendrait irrattrapable.

LLM_ENABLED = os.environ.get("LLM_ENABLED", "false").lower() == "true"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3")

# Délai de garde. Au-delà, on publie le texte brut : une panne du correcteur ne
# doit jamais rendre la transcription muette.
LLM_TIMEOUT_S = float(os.environ.get("LLM_TIMEOUT_S", "8.0"))

# Corrections simultanées, toutes sessions confondues. Sans cette borne, trois
# locuteurs terminant leurs phrases en même temps lanceraient trois générations
# concurrentes, qui disputeraient leurs cœurs à la reconnaissance elle-même.
LLM_MAX_CONCURRENT = int(os.environ.get("LLM_MAX_CONCURRENT", "1"))

# Nombre de jetons produits au maximum. Une correction fait la longueur de son
# entrée ; au-delà, c'est que le modèle a commencé à bavarder malgré la consigne.
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "256"))

LLM_PROMPT = os.environ.get(
    "LLM_PROMPT",
    "Tu es un correcteur orthographique et de syntaxe de transcription vocale. "
    "Corrige les fautes, la ponctuation et les erreurs phonétiques de cette phrase. "
    "Ne modifie pas le sens. Ne rajoute AUCUN commentaire, aucune introduction, "
    'renvoie UNIQUEMENT le texte corrigé. Texte : "{raw_text}"',
)

# Publier le texte brut immédiatement, puis le remplacer par la version corrigée.
#
# Activé par défaut, et c'est ce qui rend la lenteur du LLM sans conséquence : la
# phrase s'affiche à l'instant où elle se termine, la correction ne fait que la
# remplacer ensuite. Sans ça, une correction de trois secondes laisserait l'écran
# vide pendant trois secondes.
#
# Le remplacement se fait par `segmentId`, côté serveur et côté navigateur.
LLM_RAW_FIRST = os.environ.get("LLM_RAW_FIRST", "true").lower() == "true"

# Part maximale de mots modifiés qu'on accepte d'une correction.
#
# ⚠️ Garde-fou indispensable, et pas théorique : sur « ingénieur des logiciels »,
# qwen2.5:1.5b a rendu « ingénieur des systèmes ». Un petit modèle ne corrige pas,
# il complète avec ce qui lui semble le plus probable — consigne ou pas. Dans un
# compte-rendu de réunion, réécrire ce que les gens ont dit est pire que laisser
# une faute d'orthographe. Au-delà de ce seuil, on publie le texte brut.
LLM_MAX_CHANGE_RATIO = float(os.environ.get("LLM_MAX_CHANGE_RATIO", "0.34"))

# Corrections en attente au-delà desquelles on cesse d'en demander.
#
# ⚠️ Sans cette borne, une file sans fin se formerait dès que le LLM est plus lent
# que la parole : mesuré sur ce VPS, 60 s par correction contre une phrase toutes
# les 5 s. Les tâches s'accumuleraient jusqu'à épuiser la mémoire, en corrigeant
# des phrases vieilles de plusieurs minutes. Mieux vaut sauter des corrections que
# prendre un retard irrattrapable.
LLM_MAX_PENDING = int(os.environ.get("LLM_MAX_PENDING", "2"))

llm_stats = {
    "corrected": 0, "failed": 0, "timeouts": 0, "rejected": 0, "skipped": 0,
    "pending": 0, "totalSeconds": 0.0,
}
_http_session = None
_llm_semaphore = asyncio.Semaphore(LLM_MAX_CONCURRENT)


# ── Dépaquetage RTP ─────────────────────────────────────────────────────────


def parse_rtp(packet: bytes):
    """
    Extrait (séquence, horodatage, charge utile) d'un paquet RTP.

    ⚠️ L'en-tête ne fait PAS 12 octets en WebRTC. Sa taille dépend du nombre
    d'identifiants CSRC et de la présence d'une extension d'en-tête — et WebRTC
    en utilise systématiquement (`abs-send-time`, `transport-cc`,
    `ssrc-audio-level`, `mid`). En pratique l'en-tête fait 20 à 32 octets.
    Découper à 12 injecterait la fin de l'extension au début de la trame Opus,
    et le décodeur produirait du bruit sans jamais lever d'erreur franche.
    """
    if len(packet) < 12:
        return None

    first = packet[0]
    if first >> 6 != 2:  # version RTP
        return None

    has_padding = bool(first & 0x20)
    has_extension = bool(first & 0x10)
    csrc_count = first & 0x0F

    sequence = int.from_bytes(packet[2:4], "big")
    timestamp = int.from_bytes(packet[4:8], "big")

    offset = 12 + 4 * csrc_count
    if has_extension:
        if len(packet) < offset + 4:
            return None
        ext_words = int.from_bytes(packet[offset + 2 : offset + 4], "big")
        offset += 4 + 4 * ext_words

    end = len(packet)
    if has_padding and end > offset:
        end -= packet[-1]  # le dernier octet indique la quantité de bourrage

    if offset >= end:
        return None
    return sequence, timestamp, packet[offset:end]


def seq_delta(a: int, b: int) -> int:
    """Écart entre deux numéros de séquence 16 bits, signé, bouclage compris."""
    return ((a - b + 0x8000) & 0xFFFF) - 0x8000


def ts_delta(a: int, b: int) -> int:
    """Écart entre deux horodatages 32 bits, signé, bouclage compris."""
    return ((a - b + 0x80000000) & 0xFFFFFFFF) - 0x80000000


# ── Moteur de reconnaissance ────────────────────────────────────────────────

RECOGNIZER = None


def load_recognizer():
    """
    Charge le transducteur une fois pour tout le processus.

    sherpa-onnx est prévu pour ça : un moteur, plusieurs flux indépendants. Le
    modèle n'est donc en mémoire qu'une fois, quel que soit le nombre de
    locuteurs — contrairement à Whisper, où chaque processus du pool portait sa
    propre copie de 750 Mio.
    """
    global RECOGNIZER
    import sherpa_onnx

    directory = MODEL_DIR

    def find(pattern: str) -> str:
        from pathlib import Path

        matches = sorted(Path(directory).glob(pattern))
        if not matches:
            raise RuntimeError(f"Aucun fichier « {pattern} » dans {directory}")
        for match in matches:  # préférer int8, plus léger sur CPU
            if "int8" in match.name:
                return str(match)
        return str(matches[0])

    RECOGNIZER = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=os.path.join(directory, "tokens.txt"),
        encoder=find("encoder*.onnx"),
        decoder=find("decoder*.onnx"),
        joiner=find("joiner*.onnx"),
        num_threads=NUM_THREADS,
        sample_rate=TARGET_RATE,
        feature_dim=80,
        decoding_method=DECODING,
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=RULE1_SILENCE,
        rule2_min_trailing_silence=RULE2_SILENCE,
        rule3_min_utterance_length=RULE3_MAX_FRAMES,
    )
    log.info("Modèle chargé · %s · %d threads · %s", directory, NUM_THREADS, DECODING)


def prettify(text: str, sentence: bool = False) -> str:
    """
    Rend lisible la sortie du transducteur, sans aucun modèle.

    Ces modèles produisent du texte en capitales et sans ponctuation. Mais on
    dispose gratuitement de ce qui coûte le plus cher à retrouver : **les
    frontières de phrases**. L'endpointing du transducteur les détecte
    lui-même — c'est lui qui déclenche chaque `final` — donc un segment confirmé
    EST une phrase complète.

    Majuscule initiale et point final s'en déduisent sans rien calculer. Reste
    la ponctuation interne, les virgules, qui demanderait un vrai modèle : c'est
    la part la moins utile à la lecture, et la moins gênante pour le LLM du
    compte-rendu.

    `sentence=True` marque une phrase confirmée ; une hypothèse en cours ne doit
    pas recevoir de point, elle n'est pas finie.
    """
    text = text.strip()
    if not text:
        return text
    if text.isupper():
        text = text.lower()
    text = text[0].upper() + text[1:]
    if sentence and text[-1] not in ".!?…,;:":
        text += "."
    return text


# ── Session ─────────────────────────────────────────────────────────────────


@dataclass
class Session:
    meeting_id: str
    producer_id: str
    participant_id: str | None
    # Figé à l'ouverture : le transport peut être réattribué avant que le texte
    # ne sorte, et relire l'état courant attribuerait la parole au mauvais
    # participant.
    speaker_name: str

    packets: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=2000))
    stop: threading.Event = field(default_factory=threading.Event)

    received_packets: int = 0
    decoded_frames: int = 0
    lost_frames: int = 0
    reordered: int = 0
    decode_errors: int = 0
    audio_seconds: float = 0.0
    compute_seconds: float = 0.0
    finals: int = 0
    started_at: float = field(default_factory=time.time)

    @property
    def rtf(self) -> float:
        return self.compute_seconds / self.audio_seconds if self.audio_seconds else 0.0


SESSIONS: dict[str, Session] = {}


def worker(session: Session, loop: asyncio.AbstractEventLoop, results: asyncio.Queue) -> None:
    """
    Fil de traitement d'une session : dépaquetage, décodage, reconnaissance.

    Volontairement dans un thread et non dans la boucle d'événements : le
    décodage Opus, le rééchantillonnage et l'inférence sont des appels C
    synchrones. Dans la boucle, une session bloquerait toutes les autres — c'est
    la faute qui rendait la version précédente inutilisable à plusieurs.
    """
    import opuslib
    import soxr

    # Décodeur mono : libopus ramène lui-même un flux stéréo à un canal, ce qui
    # nous évite un mixage manuel.
    decoder = opuslib.Decoder(OPUS_RATE, 1)
    # Rééchantillonneur à état : appelé morceau par morceau sans état, il
    # introduirait une discontinuité à chaque frontière de trame.
    resampler = soxr.ResampleStream(OPUS_RATE, TARGET_RATE, 1, dtype="float32")

    stream = RECOGNIZER.create_stream()
    pending: dict[int, tuple[int, bytes]] = {}
    expected_seq: int | None = None
    last_ts: int | None = None
    last_text = ""
    last_sent = 0.0

    wav = None
    if DUMP_WAV_DIR:
        try:
            import wave

            os.makedirs(DUMP_WAV_DIR, exist_ok=True)
            safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in session.speaker_name)
            path = os.path.join(DUMP_WAV_DIR, f"{int(session.started_at)}-{safe}.wav")
            wav = wave.open(path, "wb")
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(TARGET_RATE)
            log.info("Capture audio · %s → %s", session.speaker_name, path)
        except Exception as error:
            log.warning("Capture impossible · %s: %s", session.speaker_name, error)

    def publish(kind: str, text: str) -> None:
        payload = {
            "type": kind,
            "text": prettify(text),
            "producerId": session.producer_id,
            "participantId": session.participant_id,
            "displayName": session.speaker_name,
            # Instant de prononciation : c'est la clé de tri qui remet les
            # locuteurs dans l'ordre. Elle est fixée ICI, avant toute correction,
            # pour qu'un passage par le LLM ne déplace jamais une phrase dans le
            # fil de la conversation.
            "spokenAt": round(time.time(), 3),
            "segmentId": f"{session.producer_id}-{session.finals}",
        }
        # Traversée de frontière : ce code tourne dans un thread, la file est
        # asyncio. `call_soon_threadsafe` est le seul passage sûr.
        loop.call_soon_threadsafe(results.put_nowait, payload)

    def feed(samples: np.ndarray) -> None:
        """Injecte du PCM 16 kHz dans le moteur et récolte ce qui en sort."""
        nonlocal last_text, last_sent

        started = time.perf_counter()
        stream.accept_waveform(TARGET_RATE, samples)
        while RECOGNIZER.is_ready(stream):
            RECOGNIZER.decode_stream(stream)
        text = RECOGNIZER.get_result(stream)
        endpoint = RECOGNIZER.is_endpoint(stream)
        session.compute_seconds += time.perf_counter() - started
        session.audio_seconds += len(samples) / TARGET_RATE

        now = time.monotonic()
        if endpoint:
            if text.strip():
                session.finals += 1
                publish("final", text)
            RECOGNIZER.reset(stream)
            last_text = ""
            last_sent = now
        elif text and text != last_text and now - last_sent >= PARTIAL_INTERVAL_S:
            last_text = text
            last_sent = now
            publish("partial", text)

    def decode_frame(payload: bytes | None) -> None:
        """Décode une trame, ou la reconstruit si elle est perdue."""
        nonlocal wav
        try:
            if payload is None:
                # Dissimulation de perte : libopus interpole à partir de son
                # état interne, ce qui vaut bien mieux qu'un blanc net.
                raw = decoder.decode(None, MAX_FRAME_SAMPLES, decode_fec=False)
                session.lost_frames += 1
            else:
                raw = decoder.decode(payload, MAX_FRAME_SAMPLES)
                session.decoded_frames += 1
        except Exception as error:
            session.decode_errors += 1
            # Journalisation à débit limité : sur un défaut systématique — un
            # découpage d'en-tête erroné, par exemple — on saurait, sans noyer
            # les journaux.
            if session.decode_errors in (1, 10, 100) or session.decode_errors % 1000 == 0:
                log.warning(
                    "Décodage impossible (%d au total) · %s: %s",
                    session.decode_errors, session.speaker_name, error,
                )
            return

        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if wav is not None:
            try:
                wav.writeframes((np.clip(pcm, -1, 1) * 32767).astype(np.int16).tobytes())
            except Exception:
                wav = None

        resampled = resampler.resample_chunk(pcm)
        if len(resampled):
            feed(np.ascontiguousarray(resampled, dtype=np.float32))

    def insert_silence(seconds: float) -> None:
        """Comble un trou temporel, pour que l'audio ne se comprime pas."""
        if seconds <= 0:
            return
        seconds = min(seconds, MAX_GAP_S)
        feed(np.zeros(int(seconds * TARGET_RATE), dtype=np.float32))

    def process(sequence: int, timestamp: int, payload: bytes | None) -> None:
        nonlocal last_ts
        if payload is not None and last_ts is not None:
            gap = ts_delta(timestamp, last_ts) - FRAME_SAMPLES_20MS
            if gap > 0:
                # Transmission discontinue ou silence : l'horodatage a sauté.
                insert_silence(gap / OPUS_RATE)
        if payload is not None:
            last_ts = timestamp
        decode_frame(payload)

    while not session.stop.is_set():
        try:
            packet = session.packets.get(timeout=0.5)
        except queue.Empty:
            continue
        if packet is None:
            break

        parsed = parse_rtp(packet)
        if parsed is None:
            session.decode_errors += 1
            continue
        sequence, timestamp, payload = parsed
        session.received_packets += 1

        if expected_seq is None:
            expected_seq = sequence

        # Paquet déjà dépassé : arrivé trop tard, on l'ignore plutôt que de
        # remonter le temps.
        if seq_delta(sequence, expected_seq) < 0:
            session.reordered += 1
            continue

        pending[sequence] = (timestamp, payload)

        # On dépile tant que la suite est complète, ou que la fenêtre déborde —
        # auquel cas le paquet manquant est déclaré perdu.
        while pending:
            if expected_seq in pending:
                ts, data = pending.pop(expected_seq)
                process(expected_seq, ts, data)
            elif len(pending) > REORDER_WINDOW:
                process(expected_seq, last_ts or 0, None)
            else:
                break
            expected_seq = (expected_seq + 1) & 0xFFFF

    # Fin de session : on laisse le moteur produire sa dernière phrase.
    try:
        stream.input_finished()
        while RECOGNIZER.is_ready(stream):
            RECOGNIZER.decode_stream(stream)
        tail = RECOGNIZER.get_result(stream)
        if tail.strip():
            session.finals += 1
            publish("final", tail)
    except Exception as error:
        log.warning("Fin de flux · %s: %s", session.speaker_name, error)

    if wav is not None:
        try:
            wav.close()
        except Exception:
            pass

    log.info(
        "Session fermée · %s · %d paquets · %d trames · %d perdues · %d phrases · RTF %.3f",
        session.speaker_name, session.received_packets, session.decoded_frames,
        session.lost_frames, session.finals, session.rtf,
    )


# ── Correction par LLM ──────────────────────────────────────────────────────


def _words(text: str) -> list[str]:
    """Mots comparables : sans accents, sans ponctuation, sans casse."""
    import re
    import unicodedata

    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return [word for word in re.split(r"[^a-z0-9]+", text) if word]


def changed_too_much(raw: str, corrected: str) -> bool:
    """
    Vrai si la correction s'écarte trop du texte d'origine.

    La comparaison ignore accents, ponctuation et casse — précisément ce que la
    correction est censée ajouter. Ne reste donc que ce qui compte : les mots
    a-t-il changés ? Une distance d'édition au mot répond exactement à ça.
    """
    reference = _words(raw)
    hypothesis = _words(corrected)
    if not reference:
        return True

    # Levenshtein au mot, sur une seule ligne de travail : les phrases font
    # quelques dizaines de mots, le coût est négligeable.
    previous = list(range(len(hypothesis) + 1))
    for i, ref_word in enumerate(reference, 1):
        current = [i]
        for j, hyp_word in enumerate(hypothesis, 1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (0 if ref_word == hyp_word else 1),
            ))
        previous = current

    return previous[-1] > max(1, LLM_MAX_CHANGE_RATIO * len(reference))


async def correct_text(raw: str) -> str | None:
    """
    Fait corriger une phrase par Ollama. Renvoie None si ça échoue.

    Aucune exception ne remonte : le correcteur est un agrément, pas une
    dépendance. Ollama arrêté, modèle absent, machine saturée — dans tous les
    cas on doit pouvoir publier le texte brut.
    """
    if not raw.strip() or _http_session is None:
        return None

    import aiohttp  # importé ici : la dépendance n'est requise que si LLM_ENABLED

    started = time.perf_counter()
    try:
        async with _llm_semaphore:
            async with _http_session.post(
                OLLAMA_URL,
                json={
                    "model": OLLAMA_MODEL,
                    "prompt": LLM_PROMPT.format(raw_text=raw),
                    "stream": False,
                    "options": {
                        # Température nulle : on veut une correction déterministe,
                        # pas une reformulation créative.
                        "temperature": 0,
                        "num_predict": LLM_MAX_TOKENS,
                    },
                },
                timeout=aiohttp.ClientTimeout(total=LLM_TIMEOUT_S),
            ) as response:
                if response.status != 200:
                    llm_stats["failed"] += 1
                    log.warning("Ollama a répondu %s", response.status)
                    return None
                body = await response.json()
    except asyncio.TimeoutError:
        llm_stats["timeouts"] += 1
        log.warning("Correction abandonnée après %.0f s", LLM_TIMEOUT_S)
        return None
    except Exception as error:
        llm_stats["failed"] += 1
        log.warning("Correction impossible : %s", error)
        return None

    text = (body.get("response") or "").strip()

    # Garde-fous contre un modèle bavard malgré la consigne. Les guillemets
    # encadrants sont fréquents, et une réponse démesurée signale une phrase
    # d'introduction ou un commentaire — auquel cas on préfère le texte brut.
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1].strip()
    if not text or len(text) > max(80, len(raw) * 3):
        llm_stats["failed"] += 1
        return None

    # Le modèle a-t-il corrigé, ou reformulé ? Dans le doute, le texte brut est
    # plus fidèle qu'une belle phrase qui dit autre chose.
    if changed_too_much(raw, text):
        llm_stats["rejected"] += 1
        log.warning("Correction écartée (sens modifié)\n  brut     : %s\n  corrigé  : %s", raw, text)
        return None

    llm_stats["corrected"] += 1
    llm_stats["totalSeconds"] += time.perf_counter() - started
    return text


async def send_final(websocket: WebSocket, payload: dict) -> None:
    """
    Publie une phrase confirmée, corrigée si le LLM y parvient.

    Lancée par `asyncio.create_task` : elle s'exécute pendant que la boucle
    d'ingestion continue de recevoir des paquets et que le transducteur écoute
    déjà la phrase suivante.
    """
    raw = payload["text"]

    if LLM_RAW_FIRST:
        # La phrase s'affiche à l'instant où elle se termine ; la correction la
        # remplacera par son `segmentId`.
        await websocket.send_text(json.dumps({**payload, "corrected": False}))

    llm_stats["pending"] += 1
    try:
        corrected = await correct_text(raw)
    finally:
        llm_stats["pending"] -= 1

    # Rien de neuf à publier : le texte brut est déjà à l'écran.
    if corrected is None and LLM_RAW_FIRST:
        return

    await websocket.send_text(json.dumps({
        **payload,
        "text": corrected or raw,
        "corrected": corrected is not None,
    }))


# ── API ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="stark-streaming")


@app.on_event("startup")
async def _startup() -> None:
    global _http_session
    load_recognizer()

    if LLM_ENABLED:
        import aiohttp

        # Une seule session HTTP réutilisée : en créer une par phrase gaspillerait
        # une poignée de main TCP à chaque correction.
        _http_session = aiohttp.ClientSession()
        log.info(
            "Correcteur actif · %s · %s · %d simultanée(s) · délai %.0f s",
            OLLAMA_MODEL, OLLAMA_URL, LLM_MAX_CONCURRENT, LLM_TIMEOUT_S,
        )
    else:
        log.info("Correcteur désactivé (LLM_ENABLED=false) — texte brut publié")


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _http_session is not None:
        await _http_session.close()


@app.websocket("/stream")
async def stream_endpoint(websocket: WebSocket) -> None:
    """
    Un WebSocket par locuteur actif.

    Premier message : un JSON d'identité. Ensuite, des paquets RTP bruts en
    binaire. Le service répond sur la même connexion avec les hypothèses et les
    phrases confirmées — ce qui supprime le rappel HTTP de la version
    précédente, et avec lui la route publique et son secret partagé.
    """
    await websocket.accept()

    try:
        hello = json.loads(await websocket.receive_text())
    except Exception:
        await websocket.close(code=1003)
        return

    session = Session(
        meeting_id=hello.get("meetingId", ""),
        producer_id=hello.get("producerId", ""),
        participant_id=hello.get("participantId"),
        speaker_name=hello.get("displayName") or "Participant",
    )
    SESSIONS[session.producer_id] = session
    log.info("Session ouverte · %s · réunion %s", session.speaker_name, session.meeting_id)

    loop = asyncio.get_running_loop()
    results: asyncio.Queue = asyncio.Queue()
    thread = threading.Thread(target=worker, args=(session, loop, results), daemon=True)
    thread.start()

    # Les tâches de correction sont retenues ici : une tâche sans référence peut
    # être ramassée par le collecteur avant d'avoir abouti.
    corrections: set[asyncio.Task] = set()

    async def sender() -> None:
        """
        Sortie des résultats. C'est ICI que la correction est lancée, et nulle
        part ailleurs.

        La détection de fin de phrase a lieu dans le thread de travail, où
        `asyncio.create_task` lèverait une exception faute de boucle. Le thread
        dépose donc ses résultats dans cette file, et cette coroutine — seule en
        contexte async — décide quoi en faire.

        ⚠️ Aucun `await` sur le LLM ici : la correction part en tâche de fond et
        la boucle repart immédiatement. C'est ce qui garantit que l'ingestion
        audio ne se suspend jamais.
        """
        while True:
            payload = await results.get()

            if payload["type"] == "final" and LLM_ENABLED:
                if llm_stats["pending"] >= LLM_MAX_PENDING:
                    # Le correcteur est débordé : on publie brut sans l'engorger
                    # davantage. Une phrase juste et non ponctuée vaut mieux
                    # qu'une file qui s'allonge sans fin.
                    llm_stats["skipped"] += 1
                    await websocket.send_text(json.dumps({**payload, "corrected": False}))
                    continue
                task = asyncio.create_task(send_final(websocket, payload))
                corrections.add(task)
                task.add_done_callback(corrections.discard)
            else:
                # Hypothèses : publiées telles quelles, sans jamais attendre.
                await websocket.send_text(json.dumps(payload))

    sender_task = asyncio.create_task(sender())

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data:
                try:
                    session.packets.put_nowait(data)
                except queue.Full:
                    # Le traitement ne suit plus. On sacrifie le paquet le plus
                    # récent plutôt que de bloquer la réception, ce qui ferait
                    # enfler la mémoire de tout le service.
                    session.decode_errors += 1
    except WebSocketDisconnect:
        pass
    except Exception as error:
        log.warning("WebSocket interrompu · %s: %s", session.speaker_name, error)
    finally:
        session.stop.set()
        session.packets.put(None)
        await asyncio.sleep(0.3)  # laisser la dernière phrase remonter

        # Attendre les corrections en vol : les abandonner ferait perdre les
        # dernières phrases de la réunion, celles-là même qu'on vient d'attendre.
        if corrections:
            await asyncio.wait(corrections, timeout=LLM_TIMEOUT_S + 2)

        sender_task.cancel()
        SESSIONS.pop(session.producer_id, None)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "engine": "sherpa-onnx",
        "model": MODEL_DIR,
        "threads": NUM_THREADS,
        "decoding": DECODING,
        "activeSessions": len(SESSIONS),
        "llm": {
            "enabled": LLM_ENABLED,
            "model": OLLAMA_MODEL if LLM_ENABLED else None,
            "rawFirst": LLM_RAW_FIRST,
            **llm_stats,
            "averageSeconds": round(
                llm_stats["totalSeconds"] / llm_stats["corrected"], 2
            ) if llm_stats["corrected"] else 0,
        },
        "sessions": [
            {
                "speaker": s.speaker_name,
                "meetingId": s.meeting_id,
                "receivedPackets": s.received_packets,
                "decodedFrames": s.decoded_frames,
                "lostFrames": s.lost_frames,
                "reordered": s.reordered,
                # Un compteur qui grimpe alors que les paquets arrivent signale
                # un découpage d'en-tête RTP erroné.
                "decodeErrors": s.decode_errors,
                "audioSeconds": round(s.audio_seconds, 1),
                "rtf": round(s.rtf, 3),
                "finals": s.finals,
                "queued": s.packets.qsize(),
            }
            for s in SESSIONS.values()
        ],
    }
