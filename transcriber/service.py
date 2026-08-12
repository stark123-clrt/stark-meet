"""
JALON 3 — Service de transcription en flux continu.

Reçoit du RTP Opus depuis mediasoup, le convertit en PCM par ffmpeg, transcrit
avec faster-whisper, et renvoie le texte à Node qui le rediffuse sur
`ctl:<meetingId>`.

DEUX PRINCIPES, ARRÊTÉS APRÈS L'ÉCHEC DE LA PREMIÈRE CONCEPTION :

1. ON NE JETTE JAMAIS D'AUDIO. La version précédente découpait en fenêtres
   glissantes et sacrifiait l'audio le plus ancien dès que l'inférence prenait du
   retard, pour préserver la latence. Résultat mesuré en production : un
   transcript troué, avec un marqueur « […] » devant presque chaque phrase. Un
   transcript rapide mais incomplet ne sert à rien. Ici l'audio s'accumule, et
   c'est le TEXTE qui prend du retard quand la machine ne suit pas.

2. ON DÉCOUPE AUX SILENCES, PAS AU CHRONOMÈTRE. Couper toutes les 5 s tronquait
   une phrase sur deux (« Pour aujourd'hui, », « Je pense que c'est l'une des
   choses que »). Le détecteur de voix repère la fin des phrases, et chaque
   phrase complète part en UNE seule inférence — ce qui donne du texte entier,
   ponctué, et coûte moins de calcul qu'une réanalyse permanente.

La latence devient donc « peu après que tu aies fini ta phrase » plutôt que
« deux secondes après chaque mot ». C'est le compromis explicitement demandé.

Corollaire : LocalAgreement-2 et la fenêtre ancrée ont disparu. Ils servaient à
réconcilier des passes qui se recouvraient ; ici chaque phrase n'est analysée
qu'une fois, et son texte est définitif. L'hypothèse affichée en gris reste
possible, mais comme un supplément facultatif, jamais au prix d'une phrase.
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
# Recherche par faisceau. Le passage de 1 à 5 coûte environ 40 % de calcul en
# plus et améliore nettement le français — un arbitrage évident ici, puisque la
# consigne est la complétude et la justesse, pas la latence.
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "5"))
POOL_WORKERS = int(os.environ.get("WHISPER_POOL", "2"))

# Langue forcée. Mesuré sur le VPS : la détection automatique coûte 0,6 à 1,9 s
# PAR PASSE, soit souvent la moitié du temps de calcul, pour redécouvrir chaque
# fois la même réponse. Vider cette variable rétablit la détection.
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "fr") or None

# Horodatages par mot. Coûteux — ils obligent le modèle à repasser sur l'audio
# pour aligner chaque mot — et désormais inutiles : on découpe aux silences, donc
# on connaît déjà les bornes de chaque phrase.
WORD_TIMESTAMPS = os.environ.get("WHISPER_WORD_TIMESTAMPS", "false").lower() == "true"

# Longueur à laquelle Whisper complète la fenêtre avant de l'encoder. Son défaut
# est 30 s, et c'est LE poste de dépense : mesuré sur le VPS, une fenêtre de 2 s
# et une de 5 s coûtent le même temps de calcul, ce qui prouve qu'on paie 30 s
# dans les deux cas. Le réduire divise le travail de l'encodeur d'autant.
# 0 = ne rien passer, donc comportement d'origine.
CHUNK_LENGTH = int(os.environ.get("WHISPER_CHUNK_LENGTH", "0"))

# Le paramètre n'existe pas dans toutes les versions de faster-whisper. On sonde
# une fois, puis on s'en souvient au lieu de lever la même exception à chaque
# passe.
_chunk_length_supported = CHUNK_LENGTH > 0

INITIAL_PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "Réunion Stark Meet. Visioconférence, mediasoup, Supabase, agent IA, "
    "transcription, compte-rendu, développeur, ingénieur logiciel.",
) or None

# Contexte glissant : on rappelle au modèle la fin de ce qui vient d'être dit.
# C'est le levier de qualité le plus rentable — il ne coûte presque rien en
# calcul et corrige les enchaînements absurdes (« c'est tempestat ») que produit
# un fragment analysé sans savoir ce qui le précède. Il aide aussi les noms
# propres, qui se répètent d'une phrase à l'autre.
#
# Volontairement court : un contexte long pousse Whisper à se répéter, ce qui est
# précisément le défaut que `condition_on_previous_text=False` évite par ailleurs.
# 0 désactive le mécanisme.
PROMPT_CONTEXT_CHARS = int(os.environ.get("PROMPT_CONTEXT_CHARS", "220"))

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2  # PCM 16 bits

# Silence qui marque la fin d'une phrase.
#
# 1,0 s et non 0,7 : à 0,7 s, une simple hésitation coupait la phrase en deux
# — « J'espère que… » puis « Que vous serez… » — et chaque moitié partait au
# modèle sans savoir de quoi parlait l'autre. Attendre un peu plus donne des
# phrases entières, donc plus de contexte, donc un meilleur texte.
SILENCE_S = float(os.environ.get("SILENCE_S", "1.0"))

# Phrase la plus longue qu'on accepte d'attendre. Au-delà — quelqu'un qui parle
# sans reprendre son souffle — on coupe quand même. Généreux, puisque plus de
# contexte donne une meilleure transcription et que la latence n'est pas le
# critère retenu.
MAX_UTTERANCE_S = float(os.environ.get("MAX_UTTERANCE_S", "20.0"))

# Phrase la plus courte qu'on envoie au modèle. En dessous, c'est un « oui » ou
# un bruit de bouche : Whisper y hallucine plus qu'il ne transcrit.
MIN_UTTERANCE_S = float(os.environ.get("MIN_UTTERANCE_S", "0.4"))

# Rythme d'examen du tampon. Ce n'est plus une cadence d'inférence : on ne
# calcule que lorsqu'une phrase est prête.
POLL_S = float(os.environ.get("POLL_S", "0.5"))

# Phrases transcrites SIMULTANÉMENT pour un même locuteur.
#
# Sans ça, une personne seule n'occupe qu'un processus d'inférence sur deux :
# la moitié du calcul disponible dort pendant que le retard s'accumule. Les
# phrases sont extraites du tampon dans l'ordre, lancées en parallèle, puis
# réordonnées avant affichage — le texte reste donc dans l'ordre où il a été
# prononcé.
PARALLEL_UTTERANCES = int(os.environ.get("PARALLEL_UTTERANCES", str(POOL_WORKERS)))

# Garde-fou mémoire, très au-delà de tout retard plausible : une demi-heure
# d'audio ne pèse que 58 Mio. C'est la seule circonstance où de l'audio est
# perdu, et à ce stade la machine est hors service. Volontairement généreux :
# la consigne est que TOUT soit enregistré, la latence n'ayant pas d'importance.
BUFFER_MAX_S = float(os.environ.get("BUFFER_MAX_S", "1800.0"))

# Les hypothèses en gris sont désactivées par défaut : chacune consomme une
# inférence qui doit revenir aux phrases en attente. Elles n'ont de sens que si
# l'affichage immédiat compte plus que le rattrapage, ce qui n'est pas le choix
# retenu ici.
PARTIAL_MAX_LAG_S = float(os.environ.get("PARTIAL_MAX_LAG_S", "6.0"))
PARTIALS_ENABLED = os.environ.get("PARTIALS_ENABLED", "false").lower() == "true"
PARTIAL_MIN_S = float(os.environ.get("PARTIAL_MIN_S", "2.0"))

# Filet : aucune passe ne doit pouvoir figer une session, comme observé sur le
# VPS (36 s de calcul pour 2 s d'audio).
INFERENCE_TIMEOUT_S = float(os.environ.get("INFERENCE_TIMEOUT_S", "60.0"))

# Relance de ffmpeg. Le plafond évite qu'un flux définitivement cassé — port
# occupé, codec refusé — ne relance un processus toutes les demi-secondes
# pendant toute la réunion.
FFMPEG_MAX_RESTARTS = int(os.environ.get("FFMPEG_MAX_RESTARTS", "20"))
FFMPEG_RESTART_DELAY_S = float(os.environ.get("FFMPEG_RESTART_DELAY_S", "0.5"))

# Perte d'audio minimale avant d'écrire « […] » dans le transcript.
HOLE_MIN_S = float(os.environ.get("HOLE_MIN_S", "1.5"))

NODE_CALLBACK = os.environ.get("NODE_CALLBACK_URL", "http://127.0.0.1:3001")
TRANSCRIBER_SECRET = os.environ.get("TRANSCRIBER_SECRET", "")
CALLBACK_TIMEOUT_S = 3.0


def seconds_to_bytes(seconds: float) -> int:
    return int(seconds * SAMPLE_RATE) * BYTES_PER_SAMPLE


def bytes_to_seconds(count: int) -> float:
    return count / (SAMPLE_RATE * BYTES_PER_SAMPLE)


# ── Pool d'inférence ────────────────────────────────────────────────────────
# Un modèle par processus, et non par thread : le GIL de Python et CTranslate2
# ne font pas bon ménage.

_model = None


def _init_worker() -> None:
    """Charge le modèle une fois par processus du pool."""
    global _model
    from faster_whisper import WhisperModel

    _model = WhisperModel(
        MODEL_SIZE, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=CPU_THREADS
    )
    log.info("Modèle %s chargé dans le processus %s", MODEL_SIZE, os.getpid())


def _transcribe(audio: np.ndarray, prompt: str | None = None) -> str:
    """Transcrit une phrase entière. Exécuté dans un processus du pool."""
    global _model, _chunk_length_supported
    if _model is None:  # ceinture : le pool devrait avoir appelé _init_worker
        _init_worker()

    options = dict(
        beam_size=BEAM_SIZE,
        language=LANGUAGE,
        initial_prompt=prompt or INITIAL_PROMPT,
        condition_on_previous_text=False,   # évite les boucles d'hallucination
        word_timestamps=WORD_TIMESTAMPS,
        vad_filter=False,                   # le VAD a déjà découpé en amont
        without_timestamps=True,
        # ⚠️ Décodage unique, sans repli sur des températures croissantes. Par
        # défaut, faster-whisper réessaie jusqu'à SIX fois quand il détecte de la
        # répétition — ce qui arrive systématiquement sur du bruit. Observé sur
        # le VPS : 36 s de calcul pour 2 s d'audio, et toute la session gelée.
        temperature=0.0,
    )

    if _chunk_length_supported:
        try:
            segments, _info = _model.transcribe(audio, chunk_length=CHUNK_LENGTH, **options)
        except TypeError:
            _chunk_length_supported = False
            log.warning("`chunk_length` non pris en charge — remplissage à 30 s conservé")
            segments, _info = _model.transcribe(audio, **options)
    else:
        segments, _info = _model.transcribe(audio, **options)

    return " ".join(segment.text.strip() for segment in segments).strip()


# ── Détection de voix ───────────────────────────────────────────────────────

_vad_warned = False


def speech_runs(samples: np.ndarray) -> list[tuple[int, int]]:
    """
    Plages de parole, en indices d'échantillons, via le VAD Silero embarqué avec
    faster-whisper.

    Ce n'est pas qu'une économie de calcul : sans VAD, Whisper hallucine
    massivement sur le silence (« Sous-titres réalisés par la communauté
    d'Amara.org » est le cas d'école). C'est aussi et surtout ce qui permet de
    découper aux frontières de phrases.
    """
    global _vad_warned
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        stamps = get_speech_timestamps(
            samples,
            VadOptions(
                threshold=0.5,
                min_silence_duration_ms=int(SILENCE_S * 1000),
                min_speech_duration_ms=int(MIN_UTTERANCE_S * 1000),
            ),
        )
        return [(int(stamp["start"]), int(stamp["end"])) for stamp in stamps]
    except Exception as error:
        # Journalisé une fois : sans cela, un changement de signature dans
        # faster-whisper ferait basculer silencieusement sur le repli
        # énergétique, bien moins fiable, sans que personne ne le sache.
        if not _vad_warned:
            _vad_warned = True
            log.warning("VAD Silero indisponible, repli énergétique : %s", error)
        return _energy_runs(samples)


def _energy_runs(samples: np.ndarray) -> list[tuple[int, int]]:
    """Repli grossier : plages où l'énergie dépasse un seuil, par blocs de 32 ms."""
    block = SAMPLE_RATE // 31
    if len(samples) < block:
        return []
    count = len(samples) // block
    energies = np.abs(samples[: count * block].reshape(count, block)).mean(axis=1)
    loud = energies > 0.008

    runs: list[tuple[int, int]] = []
    start = None
    gap_blocks = max(1, int(SILENCE_S * SAMPLE_RATE / block))
    silent = 0
    for index, is_loud in enumerate(loud):
        if is_loud:
            if start is None:
                start = index
            silent = 0
        elif start is not None:
            silent += 1
            if silent >= gap_blocks:
                runs.append((start * block, (index - silent + 1) * block))
                start = None
    if start is not None:
        runs.append((start * block, count * block))
    return runs


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

    # Tampon de travail. Rien n'en sort avant d'avoir été transcrit.
    buffer: bytearray = field(default_factory=bytearray)
    lock: threading.Lock = field(default_factory=threading.Lock)
    stop_flag: threading.Event = field(default_factory=threading.Event)

    committed_text: str = ""
    pcm_bytes: int = 0
    dropped_seconds: float = 0.0
    utterances: int = 0
    partials: int = 0
    timeouts: int = 0
    restarts: int = 0
    last_inference_s: float = 0.0
    last_partial_at: float = 0.0
    started_at: float = field(default_factory=time.time)

    @property
    def key(self) -> str:
        return f"{self.meeting_id}:{self.producer_id}"

    def buffered_seconds(self) -> float:
        return bytes_to_seconds(len(self.buffer))

    def head(self, seconds: float) -> np.ndarray:
        """Début du tampon, converti pour le VAD. Ne retire rien."""
        with self.lock:
            raw = bytes(self.buffer[: seconds_to_bytes(seconds)])
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    def advance(self, seconds: float) -> None:
        """Retire du tampon l'audio déjà traité."""
        if seconds <= 0:
            return
        with self.lock:
            del self.buffer[: min(seconds_to_bytes(seconds), len(self.buffer))]


SESSIONS: dict[str, Session] = {}
POOL: ProcessPoolExecutor | None = None
# Une file par réunion : deux inférences concurrentes sur les mêmes cœurs font
# exploser la latence des deux.
ROOM_LOCKS: dict[str, asyncio.Semaphore] = {}


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
    """ffmpeg lit le RTP et écrit du PCM 16 kHz mono sur sa sortie standard."""
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
    """
    Thread de lecture : vide la sortie de ffmpeg dans le tampon, et **relance
    ffmpeg** s'il s'arrête alors que la session est toujours active.

    ⚠️ Cette relance n'est pas un luxe. ffmpeg abandonne de lui-même quand aucun
    paquet ne lui parvient pendant un moment (« Connection timed out »), ce qui
    peut arriver sur le simple creux entre son démarrage et la première émission
    de mediasoup. Sans surveillance, le processus meurt, ce fil se termine, et la
    session reste vivante à recevoir zéro octet pour le reste de la réunion —
    exactement ce qui est arrivé à un participant en production, dont pas une
    seule phrase n'a été transcrite.
    """
    hard_limit = seconds_to_bytes(BUFFER_MAX_S)
    attempts = 0

    while not session.stop_flag.is_set():
        stream = session.ffmpeg.stdout if session.ffmpeg else None
        if stream is None:
            break

        while not session.stop_flag.is_set():
            chunk = stream.read(4096)
            if not chunk:
                break
            with session.lock:
                session.buffer.extend(chunk)
                session.pcm_bytes += len(chunk)
                # Seul endroit du service où de l'audio est perdu, et il faut une
                # demi-heure de retard pour l'atteindre : à ce stade la machine
                # est hors service, et laisser la mémoire enfler aggraverait tout.
                if len(session.buffer) > hard_limit:
                    cut = len(session.buffer) - hard_limit
                    del session.buffer[:cut]
                    session.dropped_seconds += bytes_to_seconds(cut)
                    log.error(
                        "Retard de plus de %.0f s · audio abandonné · %s",
                        BUFFER_MAX_S, session.speaker_name,
                    )

        if session.stop_flag.is_set():
            break

        # ffmpeg s'est arrêté seul : on le relance tant que la session vit.
        attempts += 1
        code = session.ffmpeg.poll() if session.ffmpeg else None
        if attempts > FFMPEG_MAX_RESTARTS:
            log.error(
                "ffmpeg s'arrête en boucle (%d tentatives) · %s · flux abandonné",
                attempts, session.speaker_name,
            )
            break

        log.warning(
            "ffmpeg arrêté (code %s) · %s · relance %d/%d",
            code, session.speaker_name, attempts, FFMPEG_MAX_RESTARTS,
        )
        time.sleep(FFMPEG_RESTART_DELAY_S)
        try:
            session.ffmpeg = _spawn_ffmpeg(session)
            session.restarts += 1
        except Exception as error:
            log.error("Relance de ffmpeg impossible · %s: %s", session.speaker_name, error)
            break
        # Le fil précédent s'est terminé avec l'ancien tuyau : il en faut un neuf.
        threading.Thread(target=_read_stderr, args=(session,), daemon=True).start()

    log.info(
        "Lecture PCM terminée · %s · %.1f s reçues · %d relance(s)",
        session.speaker_name, bytes_to_seconds(session.pcm_bytes), session.restarts,
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


# ── Renvoi vers Node ────────────────────────────────────────────────────────


def _post_to_node(path: str, payload: dict) -> None:
    """
    Bloquant : à appeler via asyncio.to_thread, sinon les 3 s de délai d'attente
    gèleraient la boucle d'événements de TOUTES les sessions.
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


# ── Boucle de session ───────────────────────────────────────────────────────


def _next_utterance(session: Session, final: bool = False) -> tuple[np.ndarray, float, bool] | None:
    """
    Cherche la prochaine phrase à transcrire au début du tampon.

    Renvoie (audio, secondes à retirer du tampon, phrase terminée) ou None.

    « Phrase terminée » signifie qu'un silence d'au moins SILENCE_S a été observé
    après elle : son texte est définitif. Sinon c'est une phrase en cours, dont
    on peut afficher une hypothèse sans rien consommer.

    `final=True` à la fermeture : plus aucun audio n'arrivera, donc la dernière
    phrase est terminée même sans silence de fin.
    """
    # On n'examine que le début du tampon : c'est là que se trouve la prochaine
    # phrase, et scruter cinq minutes d'audio à chaque tour serait absurde.
    scan_s = MAX_UTTERANCE_S + SILENCE_S + 1.0
    samples = session.head(scan_s)
    if len(samples) < seconds_to_bytes(MIN_UTTERANCE_S) // BYTES_PER_SAMPLE:
        return None

    runs = speech_runs(samples)

    if not runs:
        # Rien que du silence en tête. On l'élimine, en gardant une marge pour ne
        # pas amputer une phrase qui commencerait juste au bord de l'examen.
        available = len(samples) / SAMPLE_RATE
        if available > SILENCE_S * 2:
            session.advance(available - SILENCE_S)
        return None

    start, end = runs[0]
    speech_s = (end - start) / SAMPLE_RATE
    trailing_s = (len(samples) - end) / SAMPLE_RATE

    # Silero fusionne déjà les plages séparées par moins de SILENCE_S, donc un
    # silence suffisant après la première plage marque bien une fin de phrase.
    finished = final or trailing_s >= SILENCE_S or speech_s >= MAX_UTTERANCE_S

    if finished:
        cut = min(speech_s, MAX_UTTERANCE_S)
        stop = start + int(cut * SAMPLE_RATE)
        # On consomme jusqu'à la fin de la parole, pas jusqu'à la fin du silence :
        # le silence restant sera éliminé au tour suivant, et ne coûte rien.
        return samples[start:stop], (stop / SAMPLE_RATE), True

    if speech_s >= PARTIAL_MIN_S:
        return samples[start:end], 0.0, False

    return None


def _prompt_for(session: Session) -> str:
    """
    Amorce donnée au modèle : vocabulaire du domaine, nom du locuteur, puis la
    fin de ce qu'il vient de dire.

    Le nom du locuteur est là pour une raison précise : il est prononcé et
    réécrit sans cesse en réunion, et c'est exactement ce que Whisper écorche —
    « Christian Oduho » au lieu de « Christian Ondiyo ». Le lui souffler ne coûte
    rien.
    """
    parts: list[str] = []
    if INITIAL_PROMPT:
        parts.append(INITIAL_PROMPT)
    if session.speaker_name:
        # En capitales dans l'interface, mais le modèle doit écrire un nom
        # normalement capitalisé.
        parts.append(f"{session.speaker_name.title()} prend la parole.")
    if PROMPT_CONTEXT_CHARS > 0 and session.committed_text:
        parts.append(session.committed_text[-PROMPT_CONTEXT_CHARS:])
    return " ".join(parts)


async def _run_inference(session: Session, audio: np.ndarray) -> str | None:
    """Une inférence, bornée dans le temps. None si elle a échoué."""
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    try:
        text = await asyncio.wait_for(
            loop.run_in_executor(POOL, _transcribe, audio, _prompt_for(session)),
            timeout=INFERENCE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        session.timeouts += 1
        log.warning(
            "Inférence abandonnée après %.0f s · %s · %.1f s d'audio",
            INFERENCE_TIMEOUT_S, session.speaker_name, len(audio) / SAMPLE_RATE,
        )
        return None
    except Exception as error:
        log.error("Inférence en échec · %s: %s", session.speaker_name, error)
        return None

    session.last_inference_s = time.perf_counter() - started
    return text


async def _commit(session: Session, text: str) -> None:
    """Fige une phrase à l'écran."""
    if not text:
        return

    # Un trou n'est signalé que s'il est significatif : un rognage de quelques
    # dixièmes ne mérite pas un marqueur. En les signalant tous, on obtenait un
    # « […] » devant presque chaque phrase, ce qui ne renseignait plus sur rien.
    if session.dropped_seconds >= HOLE_MIN_S:
        text = "[…] " + text
    session.dropped_seconds = 0.0

    session.committed_text = f"{session.committed_text} {text}".strip()
    session.utterances += 1
    await _emit(session, "final", text)


async def _publish_ready(session: Session, inflight: list[asyncio.Task]) -> None:
    """
    Affiche les phrases terminées, EN ORDRE.

    On ne dépile que par la tête : si la deuxième phrase finit avant la
    première, elle attend. C'est ce qui permet de calculer en parallèle sans
    jamais afficher les phrases dans le désordre.
    """
    while inflight and inflight[0].done():
        task = inflight.pop(0)
        try:
            text, consume_s, audio_s, lag = await task
        except Exception as error:  # une tâche ne doit jamais tuer la boucle
            log.error("Tâche de transcription en échec · %s: %s", session.speaker_name, error)
            continue

        if text:
            log.info(
                "Phrase %d · %s · %.1f s d'audio · inférence %.2f s · retard %.1f s · %s",
                session.utterances + 1, session.speaker_name, audio_s,
                session.last_inference_s, lag, text[:60],
            )
            await _commit(session, text)
        else:
            session.dropped_seconds += consume_s


async def _session_loop(session: Session) -> None:
    """
    Boucle d'une session.

    On n'infère que lorsqu'il y a quelque chose à transcrire, et on lance
    plusieurs phrases de front tant que des processus d'inférence sont libres.
    """
    semaphore = ROOM_LOCKS.setdefault(session.meeting_id, asyncio.Semaphore(POOL_WORKERS))
    inflight: list[asyncio.Task] = []

    async def transcribe(audio, consume_s: float, lag: float):
        # Le sémaphore borne la concurrence à l'échelle de la RÉUNION : deux
        # locuteurs lançant chacun deux phrases ne doivent pas se retrouver à
        # quatre inférences pour deux processus.
        async with semaphore:
            text = await _run_inference(session, audio)
        return text, consume_s, len(audio) / SAMPLE_RATE, lag

    while not session.stop_flag.is_set():
        await asyncio.sleep(POLL_S)

        # Remplir la file tant qu'il reste de la place et des phrases prêtes.
        while len(inflight) < PARALLEL_UTTERANCES:
            # Dans un thread : le VAD analyse jusqu'à une vingtaine de secondes
            # d'audio deux fois par seconde. Dans la boucle d'événements, ce coût
            # retarderait toutes les autres sessions.
            found = await asyncio.to_thread(_next_utterance, session)
            if found is None:
                break
            audio, consume_s, finished = found
            lag = session.buffered_seconds()

            if not finished:
                # Hypothèse : facultative, et la première chose qu'on sacrifie.
                # Elle coûte une inférence qui doit revenir aux phrases en
                # attente dès que la machine peine.
                if (
                    PARTIALS_ENABLED
                    and not inflight
                    and lag <= PARTIAL_MAX_LAG_S
                    and time.time() - session.last_partial_at >= max(POLL_S, 1.5)
                ):
                    session.last_partial_at = time.time()
                    async with semaphore:
                        text = await _run_inference(session, audio)
                    if text:
                        session.partials += 1
                        await _emit(session, "partial", text)
                break

            # Consommée dès l'extraction : c'est ce qui permet à l'itération
            # suivante de voir la phrase d'après et de la lancer en parallèle.
            session.advance(consume_s)
            inflight.append(asyncio.create_task(transcribe(audio, consume_s, lag)))

        await _publish_ready(session, inflight)

    # ── Fin de session ──────────────────────────────────────────────────────
    # On attend les phrases en vol, puis on vide le tampon JUSQU'AU BOUT.
    # C'est le seul moment où un retard accumulé se rattrape : ne traiter que la
    # dernière phrase perdrait tout ce qui attendait derrière.
    pending = session.buffered_seconds()
    if pending > MIN_UTTERANCE_S:
        log.info("Rattrapage de fin · %s · %.1f s en attente", session.speaker_name, pending)

    while inflight:
        await asyncio.wait([inflight[0]])
        await _publish_ready(session, inflight)

    while True:
        found = await asyncio.to_thread(_next_utterance, session, True)
        if found is None:
            break
        audio, consume_s, _finished = found
        session.advance(consume_s)
        text = await _run_inference(session, audio)
        if text:
            await _commit(session, text)
        else:
            session.dropped_seconds += consume_s

    if pending > MIN_UTTERANCE_S:
        log.info(
            "Session vidée · %s · %d phrases au total · %.1f s abandonnées",
            session.speaker_name, session.utterances, session.dropped_seconds,
        )


# ── API HTTP ────────────────────────────────────────────────────────────────


def _warmup() -> int:
    """
    Tâche vide, dont le seul effet utile est de faire naître le processus — donc
    d'exécuter l'initialiseur qui charge le modèle.

    La pause force le pool à créer réellement POOL_WORKERS processus : sans elle,
    le premier finirait avant que le second ne soit demandé.
    """
    time.sleep(1.0)
    return os.getpid()


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    global POOL
    POOL = ProcessPoolExecutor(max_workers=POOL_WORKERS, initializer=_init_worker)

    # Préchauffage : sans ces tâches, le modèle ne se chargerait qu'à la première
    # parole, et les 15 à 25 premières secondes de la réunion seraient perdues.
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    pids = await asyncio.gather(*(loop.run_in_executor(POOL, _warmup) for _ in range(POOL_WORKERS)))
    log.info(
        "Préchauffage terminé en %.1f s · processus %s",
        time.perf_counter() - started, sorted(set(pids)),
    )
    log.info(
        "Service prêt · %s %s · %d processus · faisceau %d · silence %.1fs · "
        "phrase max %.0fs · %d en parallèle · langue %s · contexte %d car. · hypothèses %s",
        MODEL_SIZE, COMPUTE_TYPE, POOL_WORKERS, BEAM_SIZE, SILENCE_S, MAX_UTTERANCE_S,
        PARALLEL_UTTERANCES, LANGUAGE or "auto", PROMPT_CONTEXT_CHARS,
        "oui" if PARTIALS_ENABLED else "non",
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
    log.info(
        "Session fermée · %s · %d phrases · %d hypothèses",
        session.speaker_name, session.utterances, session.partials,
    )
    return {"status": "stopped", "key": key, "text": session.committed_text}


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_SIZE,
        "compute": COMPUTE_TYPE,
        "activeSessions": len(SESSIONS),
        "poolWorkers": POOL_WORKERS,
        "parallelUtterances": PARALLEL_UTTERANCES,
        "beamSize": BEAM_SIZE,
        "silenceS": SILENCE_S,
        "maxUtteranceS": MAX_UTTERANCE_S,
        "chunkLength": CHUNK_LENGTH,
        "wordTimestamps": WORD_TIMESTAMPS,
        "partials": PARTIALS_ENABLED,
        "language": LANGUAGE or "auto",
        "callbackUrl": NODE_CALLBACK,
        "secretConfigured": bool(TRANSCRIBER_SECRET),
        "sessions": [
            {
                "speaker": s.speaker_name,
                "meetingId": s.meeting_id,
                "rtpPort": s.rtp_port,
                "receivedSeconds": round(bytes_to_seconds(s.pcm_bytes), 1),
                # Retard réel : audio reçu mais pas encore transcrit.
                "lagSeconds": round(s.buffered_seconds(), 1),
                "utterances": s.utterances,
                "partials": s.partials,
                "lastInferenceS": round(s.last_inference_s, 2),
                "timeouts": s.timeouts,
                "ffmpegRestarts": s.restarts,
                "droppedSeconds": round(s.dropped_seconds, 1),
                "words": len(s.committed_text.split()),
            }
            for s in SESSIONS.values()
        ],
    }
