"""
JALON 3 — Service de transcription en flux continu.

Reçoit du RTP Opus depuis mediasoup, le convertit en PCM par ffmpeg, transcrit
avec faster-whisper, et renvoie le texte à Node qui le rediffuse sur
`ctl:<meetingId>`.

DEUX MÉCANISMES PORTENT TOUTE LA CONCEPTION :

1. LA FENÊTRE ANCRÉE. Whisper n'est pas un modèle de flux : il est entraîné sur
   des fenêtres de 30 s et infère par blocs. Découper en morceaux indépendants
   de 500 ms produirait du texte haché et halluciné. On réanalyse donc à chaque
   cadence tout l'audio depuis un ANCRAGE, qui n'avance que sur ce qui est
   confirmé.

   ⚠️ L'ancrage est le point à ne pas rater. Une fenêtre glissante classique
   — « les 4 dernières secondes » — casse le mécanisme 2 : deux passes
   consécutives n'y partagent aucun début commun, donc rien n'est jamais
   confirmé et le transcript reste éternellement en hypothèse.

2. LOCALAGREEMENT-2. Comme la fenêtre est réanalysée, le texte change d'une
   passe à l'autre. On ne fige à l'écran que ce que DEUX passes consécutives
   confirment — le reste s'affiche en hypothèse, et peut encore bouger.

Paramètres arrêtés après mesure sur le VPS (RTF `small` = 0,399 sur 3 cœurs).
Le coût d'une passe vaut « longueur de fenêtre × RTF » : c'est MAX_WINDOW_S,
et non la cadence, qui fixe la capacité en locuteurs simultanés.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import subprocess
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field

import numpy as np
import requests
from fastapi import FastAPI
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("transcriber")

# ── Réglages ────────────────────────────────────────────────────────────────

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
CPU_THREADS = int(os.environ.get("WHISPER_THREADS", "2"))
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "1"))
POOL_WORKERS = int(os.environ.get("WHISPER_POOL", "2"))

# Langue forcée. Mesuré sur le VPS : la détection automatique coûte 0,6 à 1,9 s
# PAR PASSE, soit souvent la moitié du temps de calcul, pour redécouvrir à chaque
# fois la même réponse. Vider cette variable rétablit la détection.
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "fr") or None

# Horodatages par mot. Ils obligent le modèle à repasser sur l'audio pour aligner
# chaque mot, ce qui est cher. Ils servent à savoir de combien avancer l'ancrage
# après une confirmation ; sans eux, on interpole depuis les bornes du segment,
# qui sont gratuites. À comparer par la mesure avant de trancher.
WORD_TIMESTAMPS = os.environ.get("WHISPER_WORD_TIMESTAMPS", "true").lower() == "true"

# Longueur à laquelle Whisper complète la fenêtre avant de l'encoder. Son défaut
# est 30 s, et c'est LE poste de dépense : mesuré sur le VPS, une fenêtre de 2 s
# et une de 5 s coûtent le même temps de calcul, ce qui prouve qu'on paie 30 s
# dans les deux cas. Réduire ce remplissage à peine plus que la fenêtre réelle
# divise le travail de l'encodeur d'autant.
#
# Contrepartie : le modèle n'a jamais vu d'entrées courtes à l'entraînement, la
# qualité peut s'en ressentir. À valider par la mesure, d'où la variable.
# 0 = ne rien passer, donc comportement d'origine.
CHUNK_LENGTH = int(os.environ.get("WHISPER_CHUNK_LENGTH", "6"))

# Le paramètre n'existe pas dans toutes les versions de faster-whisper. On sonde
# une fois, puis on s'en souvient au lieu de lever la même exception à chaque
# passe.
_chunk_length_supported = CHUNK_LENGTH > 0

INITIAL_PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "Réunion Stark Meet. Visioconférence, mediasoup, Supabase, agent IA, "
    "transcription, compte-rendu, développeur, ingénieur logiciel.",
) or None

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2  # PCM 16 bits

# Audio minimum avant la première passe. En dessous, Whisper n'a pas assez de
# contexte et produit surtout du bruit.
MIN_WINDOW_S = float(os.environ.get("MIN_WINDOW_S", "1.5"))

# Longueur maximale de la fenêtre analysée. Au-delà, on force la confirmation
# de l'hypothèse et on avance l'ancrage.
#
# C'est le réglage qui pèse le plus sur la latence RESSENTIE : le coût d'une
# passe vaut « longueur × RTF », donc une fenêtre de 8 s faisait attendre plus de
# trois secondes rien qu'en calcul. À 5 s on perd un peu de contexte sur les
# phrases longues et on gagne partout ailleurs.
MAX_WINDOW_S = float(os.environ.get("MAX_WINDOW_S", "5.0"))

CADENCE_S = float(os.environ.get("CADENCE_S", "2.0"))

# Silence qui clôt un segment : on confirme alors l'hypothèse et on repart
# propre. Sans ce vidage, le contexte s'accumule et Whisper se met à halluciner.
SILENCE_FLUSH_S = float(os.environ.get("SILENCE_FLUSH_S", "0.6"))

# Contre-pression : au-delà de ce retard accumulé, on abandonne l'audio le plus
# ancien. Mieux vaut un trou signalé qu'un transcript qui dérive de 30 s.
MAX_LAG_S = float(os.environ.get("MAX_LAG_S", "3.0"))

# Au-delà, la fenêtre est abandonnée. Généreux par rapport aux ~1,5 s mesurées :
# ce n'est pas un réglage de performance mais un filet, pour qu'un cas imprévu ne
# puisse pas figer une session comme observé sur le VPS.
INFERENCE_TIMEOUT_S = float(os.environ.get("INFERENCE_TIMEOUT_S", "8.0"))

# Perte d'audio minimale avant d'écrire « […] » dans le transcript.
HOLE_MIN_S = float(os.environ.get("HOLE_MIN_S", "1.5"))

NODE_CALLBACK = os.environ.get("NODE_CALLBACK_URL", "http://127.0.0.1:3001")
# En `--network host`, le port 3001 de l'hôte appartient à Traefik : ce défaut
# ne sert qu'au développement, la vraie valeur est l'URL publique de mediasoup.
TRANSCRIBER_SECRET = os.environ.get("TRANSCRIBER_SECRET", "")
CALLBACK_TIMEOUT_S = 3.0


def seconds_to_bytes(seconds: float) -> int:
    return int(seconds * SAMPLE_RATE) * BYTES_PER_SAMPLE


# ── Pool d'inférence ────────────────────────────────────────────────────────
# Un modèle par processus, et non par thread : le GIL de Python et CTranslate2
# ne font pas bon ménage. Deux processus × 750 Mio ≈ 1,5 Gio.

_model = None


def _init_worker() -> None:
    """Charge le modèle une fois par processus du pool."""
    global _model
    from faster_whisper import WhisperModel

    _model = WhisperModel(
        MODEL_SIZE, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=CPU_THREADS
    )
    log.info("Modèle %s chargé dans le processus %s", MODEL_SIZE, os.getpid())


def _transcribe_window(audio: np.ndarray) -> list[tuple[str, float, float]]:
    """
    Transcrit une fenêtre. Exécuté dans un processus du pool.

    Renvoie une liste de (mot, début, fin) — au mot et non à la phrase, car
    LocalAgreement-2 compare mot à mot et l'ancrage avance à la fin d'un mot.
    """
    global _model, _chunk_length_supported
    if _model is None:  # ceinture : le pool devrait avoir appelé _init_worker
        _init_worker()

    options = dict(
        beam_size=BEAM_SIZE,
        language=LANGUAGE,
        initial_prompt=INITIAL_PROMPT,
        condition_on_previous_text=False,        # évite les boucles d'hallucination
        word_timestamps=WORD_TIMESTAMPS,
        vad_filter=False,                        # le VAD est déjà passé en amont
        # Les jetons d'horodatage de segment sont du texte décodé en pure perte
        # ici : on connaît déjà les bornes de la fenêtre qu'on a fournie.
        without_timestamps=not WORD_TIMESTAMPS,
        # ⚠️ Décodage unique, sans repli sur des températures croissantes. Par
        # défaut, faster-whisper réessaie jusqu'à SIX fois quand il détecte de la
        # répétition — ce qui arrive systématiquement sur du bruit. Observé sur
        # le VPS : 36 s de calcul pour 2 s d'audio, et toute la session gelée.
        # En flux continu, mieux vaut un segment médiocre qu'une passe sans fin.
        temperature=0.0,
    )

    if _chunk_length_supported:
        try:
            segments, _info = _model.transcribe(audio, chunk_length=CHUNK_LENGTH, **options)
        except TypeError:
            # Version de faster-whisper sans ce paramètre : on le note et on ne
            # réessaiera plus.
            _chunk_length_supported = False
            log.warning("`chunk_length` non pris en charge — remplissage à 30 s conservé")
            segments, _info = _model.transcribe(audio, **options)
    else:
        segments, _info = _model.transcribe(audio, **options)

    words: list[tuple[str, float, float]] = []
    for segment in segments:
        if WORD_TIMESTAMPS and segment.words:
            for word in segment.words:
                text = word.word.strip()
                if text:
                    words.append((text, word.start, word.end))
            continue

        # Repli sans alignement : on répartit les mots du segment sur sa durée,
        # au prorata de leur longueur. C'est approximatif, mais l'ancrage n'a
        # besoin que d'une borne raisonnable — pas d'une précision au mot. Une
        # coupe un peu trop tôt fait simplement réanalyser un mot de plus.
        pieces = [piece for piece in segment.text.strip().split() if piece]
        if not pieces:
            continue
        span = max(segment.end - segment.start, 0.01)
        total = sum(len(piece) for piece in pieces)
        cursor = segment.start
        for piece in pieces:
            share = span * (len(piece) / total)
            words.append((piece, cursor, cursor + share))
            cursor += share
    return words


# ── LocalAgreement-2 ────────────────────────────────────────────────────────


def local_agreement(
    previous: list[tuple[str, float, float]],
    current: list[tuple[str, float, float]],
) -> tuple[list[tuple[str, float, float]], list[tuple[str, float, float]]]:
    """
    Compare deux passes et renvoie (mots confirmés, hypothèse restante).

    Le préfixe commun aux deux passes est considéré comme stable : deux
    inférences indépendantes qui produisent la même suite de mots se trompent
    rarement de la même façon.

    Ne fonctionne que parce que les deux passes partent du MÊME ancrage — d'où
    le mécanisme 1 en tête de fichier.
    """
    index = 0
    limit = min(len(previous), len(current))
    while index < limit and previous[index][0].lower() == current[index][0].lower():
        index += 1
    return current[:index], current[index:]


# ── Session ─────────────────────────────────────────────────────────────────


@dataclass
class Session:
    meeting_id: str
    producer_id: str
    participant_id: str | None
    # Figé à l'ouverture : le transport peut être recyclé vers quelqu'un d'autre
    # avant que Whisper ne rende son texte. Relire l'état courant attribuerait
    # la parole au mauvais participant.
    speaker_name: str
    rtp_port: int
    payload_type: int

    ffmpeg: subprocess.Popen | None = None
    reader: threading.Thread | None = None
    stderr_reader: threading.Thread | None = None
    task: asyncio.Task | None = None  # référence gardée, sinon le GC peut l'annuler
    sdp_path: str = ""

    # Tampon PCM depuis l'ancrage. Ce qui est confirmé en est retiré.
    buffer: bytearray = field(default_factory=bytearray)
    lock: threading.Lock = field(default_factory=threading.Lock)
    stop_flag: threading.Event = field(default_factory=threading.Event)

    previous_words: list[tuple[str, float, float]] = field(default_factory=list)
    committed_text: str = ""
    # Cumul, contrairement au tampon qui se vide : c'est la seule mesure qui
    # répond sans ambiguïté à « le RTP arrive-t-il ? ».
    pcm_bytes: int = 0
    # Audio réellement perdu depuis le dernier marqueur. Compté en secondes et
    # non par un simple drapeau : les rognages de quelques dixièmes sont normaux
    # et signaler chacun d'eux collait un « […] » devant presque chaque phrase,
    # ce qui rendait le marqueur illisible ET faux.
    dropped_seconds: float = 0.0
    dropped_windows: int = 0
    passes: int = 0
    timeouts: int = 0
    last_inference_s: float = 0.0
    started_at: float = field(default_factory=time.time)

    @property
    def key(self) -> str:
        return f"{self.meeting_id}:{self.producer_id}"

    def buffered_seconds(self) -> float:
        return len(self.buffer) / (SAMPLE_RATE * BYTES_PER_SAMPLE)

    def take_window(self) -> tuple[np.ndarray, float] | None:
        """
        Copie l'audio depuis l'ancrage, sans le retirer : le recouvrement entre
        deux passes est ce qui permet à LocalAgreement-2 de comparer.

        Renvoie aussi la LONGUEUR analysée. Sans elle, on ne saurait pas de
        combien avancer l'ancrage quand rien n'est confirmé, et vider tout le
        tampon jetterait les mots arrivés pendant l'inférence.
        """
        with self.lock:
            if len(self.buffer) < seconds_to_bytes(MIN_WINDOW_S):
                return None

            # Contre-pression. Le tampon ne devrait jamais dépasser la fenêtre
            # maximale : s'il le fait, l'inférence ne suit pas le temps réel et
            # on sacrifie l'audio le plus ancien pour ne pas dériver sans fin.
            limit = seconds_to_bytes(MAX_WINDOW_S + MAX_LAG_S)
            if len(self.buffer) > limit:
                cut = len(self.buffer) - seconds_to_bytes(MAX_WINDOW_S)
                del self.buffer[:cut]
                self.previous_words = []  # l'ancrage a sauté : plus rien n'est comparable
                self.dropped_windows += 1
                self.dropped_seconds += cut / (SAMPLE_RATE * BYTES_PER_SAMPLE)
                log.warning("Retard > %.1f s · audio abandonné · %s", MAX_LAG_S, self.speaker_name)

            raw = bytes(self.buffer[: seconds_to_bytes(MAX_WINDOW_S)])

        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        return samples, len(raw) / (SAMPLE_RATE * BYTES_PER_SAMPLE)

    def advance(self, seconds: float) -> None:
        """Avance l'ancrage : l'audio traité n'a plus à être réanalysé."""
        if seconds <= 0:
            return
        with self.lock:
            del self.buffer[: min(seconds_to_bytes(seconds), len(self.buffer))]


SESSIONS: dict[str, Session] = {}
POOL: ProcessPoolExecutor | None = None
# Une file par réunion : deux inférences concurrentes sur les mêmes cœurs font
# exploser la latence des deux.
ROOM_LOCKS: dict[str, asyncio.Semaphore] = {}
_vad_warned = False


def _sdp_for(session: Session) -> str:
    # ⚠️ `c=IN IP4 0.0.0.0` et non 127.0.0.1 : c'est cette ligne qui dit à ffmpeg
    # sur quelle interface se lier. Sur le loopback, il n'entendrait rien des
    # paquets que mediasoup envoie à l'adresse de l'hôte sur le bridge Docker —
    # et il attendrait indéfiniment, sans erreur ni avertissement.
    return "\n".join(
        [
            "v=0",
            "o=- 0 0 IN IP4 0.0.0.0",
            "s=stark-meet-fork",
            "c=IN IP4 0.0.0.0",
            "t=0 0",
            f"m=audio {session.rtp_port} RTP/AVP {session.payload_type}",
            f"a=rtpmap:{session.payload_type} opus/48000/2",
            "a=recvonly",
            "",
        ]
    )


def _spawn_ffmpeg(session: Session) -> subprocess.Popen:
    """
    ffmpeg lit le RTP et écrit du PCM 16 kHz mono sur sa sortie standard.

    Jamais de fichier intermédiaire en régime nominal : le disque de cette
    machine est déjà sollicité par Postgres.
    """
    session.sdp_path = f"/tmp/fork-{session.producer_id}.sdp"
    with open(session.sdp_path, "w", encoding="utf-8") as handle:
        handle.write(_sdp_for(session))

    return subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-protocol_whitelist", "file,rtp,udp",
            "-fflags", "+nobuffer", "-flags", "low_delay",
            "-i", session.sdp_path,
            "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-f", "s16le", "-",
        ],
        stdout=subprocess.PIPE,
        # Jeter cette sortie rend le diagnostic impossible : quand aucun paquet
        # n'arrive, ffmpeg est le seul à savoir pourquoi.
        stderr=subprocess.PIPE,
        bufsize=0,
    )


def _read_pcm(session: Session) -> None:
    """Thread de lecture : vide la sortie de ffmpeg dans le tampon."""
    stream = session.ffmpeg.stdout if session.ffmpeg else None
    if stream is None:
        return
    while not session.stop_flag.is_set():
        chunk = stream.read(4096)
        if not chunk:
            break
        with session.lock:
            session.buffer.extend(chunk)
            session.pcm_bytes += len(chunk)
            # Garde-fou côté producteur. La contre-pression de take_window ne
            # sert à rien si la boucle de transcription est bloquée : le tampon
            # gonflait alors sans limite (33 s observées pour un plafond de 8).
            # Ici, la borne tient quoi qu'il arrive en aval.
            hard_limit = seconds_to_bytes(MAX_WINDOW_S + MAX_LAG_S)
            if len(session.buffer) > hard_limit:
                cut = len(session.buffer) - hard_limit
                del session.buffer[:cut]
                session.dropped_seconds += cut / (SAMPLE_RATE * BYTES_PER_SAMPLE)
    log.info(
        "Lecture PCM terminée · %s · %.1f s reçues",
        session.speaker_name, session.pcm_bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE),
    )


def _read_stderr(session: Session) -> None:
    """Relaie les messages de ffmpeg dans les journaux du service."""
    stream = session.ffmpeg.stderr if session.ffmpeg else None
    if stream is None:
        return
    for raw in stream:
        line = raw.decode("utf-8", "replace").strip()
        if line:
            log.warning("ffmpeg · %s · %s", session.speaker_name, line)


def _has_speech(samples: np.ndarray) -> bool:
    """
    VAD Silero, embarqué avec faster-whisper — pas de dépendance de plus.

    Ce n'est pas qu'une économie de calcul : sans lui, Whisper hallucine
    massivement sur le silence (« Sous-titres réalisés par la communauté
    d'Amara.org » est le cas d'école).
    """
    global _vad_warned
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        stamps = get_speech_timestamps(
            samples,
            VadOptions(threshold=0.5, min_silence_duration_ms=int(SILENCE_FLUSH_S * 1000)),
        )
        return len(stamps) > 0
    except Exception as error:
        # Journalisé une fois : sans cela, un changement de signature dans
        # faster-whisper ferait basculer silencieusement sur le repli
        # énergétique, bien moins fiable, sans que personne ne le sache.
        if not _vad_warned:
            _vad_warned = True
            log.warning("VAD Silero indisponible, repli énergétique : %s", error)
        return bool(np.abs(samples).mean() > 0.001)


def _post_to_node(path: str, payload: dict) -> None:
    """
    Renvoi vers Node. Un échec ne doit jamais interrompre la transcription.

    Bloquant : à appeler via asyncio.to_thread, sinon les 3 s de délai
    d'attente gèleraient la boucle d'événements de TOUTES les sessions.
    """
    try:
        requests.post(
            f"{NODE_CALLBACK}{path}",
            json=payload,
            headers={"X-Transcriber-Secret": TRANSCRIBER_SECRET},
            timeout=CALLBACK_TIMEOUT_S,
        )
    except Exception as error:
        log.warning("Renvoi vers Node impossible (%s): %s", path, error)


async def _emit(session: Session, kind: str, text: str) -> None:
    """Envoie un fragment à Node. `kind` vaut 'final' ou 'partial'."""
    if not text:
        return
    await asyncio.to_thread(
        _post_to_node,
        "/internal/transcript",
        {
            "meetingId": session.meeting_id,
            "participantId": session.participant_id,
            # Le nom de la clé doit rester `displayName` : c'est ce que lit
            # /internal/transcript côté Node.
            "displayName": session.speaker_name,
            "producerId": session.producer_id,
            "type": kind,
            "text": text,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        },
    )


def _join(words: list[tuple[str, float, float]]) -> str:
    return " ".join(word for word, _start, _end in words)


async def _commit(session: Session, words: list[tuple[str, float, float]]) -> None:
    """Fige des mots à l'écran et les retire de l'audio à réanalyser."""
    if not words:
        return

    text = _join(words)
    # Un trou est signalé seulement s'il est significatif : deux phrases sans
    # rapport collées bout à bout tromperaient le lecteur et le LLM du
    # compte-rendu, mais un rognage de quelques dixièmes ne mérite pas un
    # marqueur — en le signalant systématiquement, on obtenait un « […] » devant
    # presque chaque phrase, ce qui ne renseignait plus sur rien.
    if session.dropped_seconds >= HOLE_MIN_S:
        text = "[…] " + text
    session.dropped_seconds = 0.0

    session.committed_text = f"{session.committed_text} {text}".strip()
    await _emit(session, "final", text)


async def _session_loop(session: Session) -> None:
    """Boucle de transcription d'une session, cadencée à CADENCE_S."""
    loop = asyncio.get_running_loop()
    semaphore = ROOM_LOCKS.setdefault(session.meeting_id, asyncio.Semaphore(POOL_WORKERS))

    while not session.stop_flag.is_set():
        await asyncio.sleep(CADENCE_S)

        taken = session.take_window()
        if taken is None:
            continue
        samples, window_seconds = taken

        if not _has_speech(samples):
            # Silence sur toute la fenêtre : ce qui restait en hypothèse ne sera
            # jamais mieux confirmé, on le fige et on repart d'un ancrage neuf.
            #
            # ⚠️ On avance de la longueur ANALYSÉE, on ne vide pas le tampon :
            # de l'audio a pu arriver pendant qu'on travaillait, et le jeter
            # ferait disparaître le début de la phrase suivante.
            await _commit(session, session.previous_words)
            session.advance(window_seconds)
            session.previous_words = []
            continue

        # Instrumentation délibérée à chaque passe. Sans ces trois durées, un
        # blocage est indiscernable d'une lenteur : on voit seulement que rien
        # n'avance, sans savoir si c'est l'attente d'un processus, le VAD ou
        # l'inférence elle-même.
        queued_at = time.perf_counter()
        async with semaphore:
            acquired_at = time.perf_counter()
            try:
                # Garde-fou de dernier recours. `temperature=0` supprime la cause
                # connue des passes interminables, mais une session ne doit jamais
                # pouvoir se figer sur un cas que je n'ai pas prévu : on abandonne
                # la fenêtre et on continue.
                words = await asyncio.wait_for(
                    loop.run_in_executor(POOL, _transcribe_window, samples),
                    timeout=INFERENCE_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                log.warning(
                    "Inférence abandonnée après %.0f s · %s · fenêtre %.1fs",
                    INFERENCE_TIMEOUT_S, session.speaker_name, window_seconds,
                )
                session.timeouts += 1
                session.dropped_seconds += window_seconds
                session.advance(window_seconds)
                session.previous_words = []
                continue
            except Exception as error:
                log.error("Inférence en échec · %s: %s", session.speaker_name, error)
                continue
            done_at = time.perf_counter()

        session.passes += 1
        session.last_inference_s = done_at - acquired_at
        log.info(
            "Passe %d · %s · fenêtre %.1fs · attente %.2fs · inférence %.2fs · RTF %.2f · %d mots",
            session.passes, session.speaker_name, window_seconds,
            acquired_at - queued_at, session.last_inference_s,
            session.last_inference_s / max(window_seconds, 0.01), len(words),
        )
        committed, hypothesis = local_agreement(session.previous_words, words)

        if committed:
            await _commit(session, committed)
            # L'ancrage avance jusqu'à la fin du dernier mot confirmé, et les
            # horodatages de l'hypothèse sont recalés sur le nouvel ancrage.
            cut = committed[-1][2]
            session.advance(cut)
            session.previous_words = [
                (word, start - cut, end - cut) for word, start, end in hypothesis
            ]
        else:
            session.previous_words = words

        # Fenêtre saturée sans confirmation : Whisper hésite (bruit, chevauchement
        # de voix). On fige l'hypothèse plutôt que de payer indéfiniment le coût
        # d'une fenêtre maximale, qui pénaliserait tous les autres locuteurs.
        # Là encore on avance de la longueur analysée, sans vider le tampon.
        if session.buffered_seconds() >= MAX_WINDOW_S:
            await _commit(session, session.previous_words)
            session.advance(window_seconds)
            session.previous_words = []

    # Départ du locuteur : ce qui restait en hypothèse est la fin de sa phrase.
    await _commit(session, session.previous_words)
    session.previous_words = []


# ── API HTTP ────────────────────────────────────────────────────────────────


def _warmup() -> int:
    """
    Tâche vide, dont le seul effet utile est de faire naître le processus — donc
    d'exécuter l'initialiseur qui charge le modèle.

    La pause force le pool à créer réellement POOL_WORKERS processus : sans
    elle, le premier finirait avant que le second ne soit demandé, et un seul
    modèle serait chargé.
    """
    time.sleep(1.0)
    return os.getpid()


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    global POOL
    POOL = ProcessPoolExecutor(max_workers=POOL_WORKERS, initializer=_init_worker)

    # Préchauffage. ProcessPoolExecutor est paresseux : sans ces tâches, le
    # modèle ne se chargerait qu'à la première parole, et les 15 à 25 premières
    # secondes de la réunion seraient perdues à attendre le chargement.
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    pids = await asyncio.gather(*(loop.run_in_executor(POOL, _warmup) for _ in range(POOL_WORKERS)))
    log.info(
        "Préchauffage terminé en %.1f s · processus %s",
        time.perf_counter() - started, sorted(set(pids)),
    )

    log.info(
        "Service prêt · %s %s · %d processus · fenêtre %.1f-%.1fs · cadence %.1fs · "
        "langue %s · horodatage par mot %s · remplissage %s",
        MODEL_SIZE, COMPUTE_TYPE, POOL_WORKERS, MIN_WINDOW_S, MAX_WINDOW_S, CADENCE_S,
        LANGUAGE or "auto", "oui" if WORD_TIMESTAMPS else "non",
        f"{CHUNK_LENGTH}s" if CHUNK_LENGTH > 0 else "30s (défaut)",
    )
    if not TRANSCRIBER_SECRET:
        log.warning("TRANSCRIBER_SECRET vide — Node refusera tous les renvois")
    yield
    for session in list(SESSIONS.values()):
        _terminate(session)
    if POOL:
        POOL.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="stark-transcriber", lifespan=lifespan)


class StartRequest(BaseModel):
    meetingId: str
    producerId: str
    participantId: str | None = None
    displayName: str = "Participant"
    rtpPort: int
    payloadType: int = 111


class StopRequest(BaseModel):
    meetingId: str
    producerId: str


def _terminate(session: Session) -> None:
    """Arrêt matériel d'une session. Idempotent."""
    session.stop_flag.set()
    if session.ffmpeg:
        with contextlib.suppress(Exception):
            session.ffmpeg.terminate()
    if session.sdp_path:
        with contextlib.suppress(OSError):
            os.unlink(session.sdp_path)


@app.post("/session/start")
async def session_start(request: StartRequest) -> dict:
    key = f"{request.meetingId}:{request.producerId}"
    if key in SESSIONS:
        return {"status": "already-running", "key": key}

    session = Session(
        meeting_id=request.meetingId,
        producer_id=request.producerId,
        participant_id=request.participantId,
        speaker_name=request.displayName,
        rtp_port=request.rtpPort,
        payload_type=request.payloadType,
    )

    try:
        session.ffmpeg = _spawn_ffmpeg(session)
    except FileNotFoundError:
        log.error("ffmpeg introuvable dans l'image")
        return {"status": "error", "reason": "ffmpeg-missing"}

    session.reader = threading.Thread(target=_read_pcm, args=(session,), daemon=True)
    session.reader.start()
    session.stderr_reader = threading.Thread(target=_read_stderr, args=(session,), daemon=True)
    session.stderr_reader.start()

    SESSIONS[key] = session
    session.task = asyncio.create_task(_session_loop(session))

    log.info("Session ouverte · %s · port %d", session.speaker_name, session.rtp_port)
    return {"status": "started", "key": key}


@app.post("/session/stop")
async def session_stop(request: StopRequest) -> dict:
    key = f"{request.meetingId}:{request.producerId}"
    session = SESSIONS.pop(key, None)
    if not session:
        return {"status": "unknown", "key": key}

    _terminate(session)
    log.info("Session fermée · %s · %d passes", session.speaker_name, session.passes)
    return {"status": "stopped", "key": key, "text": session.committed_text}


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_SIZE,
        "compute": COMPUTE_TYPE,
        "activeSessions": len(SESSIONS),
        "poolWorkers": POOL_WORKERS,
        "minWindowS": MIN_WINDOW_S,
        "maxWindowS": MAX_WINDOW_S,
        "cadenceS": CADENCE_S,
        "chunkLength": CHUNK_LENGTH,
        "wordTimestamps": WORD_TIMESTAMPS,
        "language": LANGUAGE or "auto",
        "callbackUrl": NODE_CALLBACK,
        "secretConfigured": bool(TRANSCRIBER_SECRET),
        "sessions": [
            {
                "speaker": s.speaker_name,
                "meetingId": s.meeting_id,
                "bufferedSeconds": round(s.buffered_seconds(), 1),
                "receivedSeconds": round(s.pcm_bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE), 1),
                "rtpPort": s.rtp_port,
                "passes": s.passes,
                "lastInferenceS": round(s.last_inference_s, 2),
                "timeouts": s.timeouts,
                "droppedWindows": s.dropped_windows,
                "words": len(s.committed_text.split()),
            }
            for s in SESSIONS.values()
        ],
    }
