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
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
POOL_WORKERS = int(os.environ.get("WHISPER_POOL", "2"))

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
# de l'hypothèse et on avance l'ancrage. C'est un arbitrage direct :
# l'allonger améliore le contexte de Whisper et coûte proportionnellement plus
# de CPU, donc moins de locuteurs simultanés.
MAX_WINDOW_S = float(os.environ.get("MAX_WINDOW_S", "8.0"))

CADENCE_S = float(os.environ.get("CADENCE_S", "2.0"))

# Silence qui clôt un segment : on confirme alors l'hypothèse et on repart
# propre. Sans ce vidage, le contexte s'accumule et Whisper se met à halluciner.
SILENCE_FLUSH_S = float(os.environ.get("SILENCE_FLUSH_S", "0.6"))

# Contre-pression : au-delà de ce retard accumulé, on abandonne l'audio le plus
# ancien. Mieux vaut un trou signalé qu'un transcript qui dérive de 30 s.
MAX_LAG_S = float(os.environ.get("MAX_LAG_S", "3.0"))

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
    global _model
    if _model is None:  # ceinture : le pool devrait avoir appelé _init_worker
        _init_worker()

    segments, _info = _model.transcribe(
        audio,
        beam_size=BEAM_SIZE,
        language=LANGUAGE,
        initial_prompt=INITIAL_PROMPT,
        condition_on_previous_text=False,  # évite les boucles d'hallucination
        word_timestamps=True,              # requis par LocalAgreement-2
        vad_filter=False,                  # le VAD est déjà passé en amont
    )

    words: list[tuple[str, float, float]] = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append((text, word.start, word.end))
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
    task: asyncio.Task | None = None  # référence gardée, sinon le GC peut l'annuler
    sdp_path: str = ""

    # Tampon PCM depuis l'ancrage. Ce qui est confirmé en est retiré.
    buffer: bytearray = field(default_factory=bytearray)
    lock: threading.Lock = field(default_factory=threading.Lock)
    stop_flag: threading.Event = field(default_factory=threading.Event)

    previous_words: list[tuple[str, float, float]] = field(default_factory=list)
    committed_text: str = ""
    pending_hole: bool = False
    dropped_windows: int = 0
    passes: int = 0
    started_at: float = field(default_factory=time.time)

    @property
    def key(self) -> str:
        return f"{self.meeting_id}:{self.producer_id}"

    def buffered_seconds(self) -> float:
        return len(self.buffer) / (SAMPLE_RATE * BYTES_PER_SAMPLE)

    def take_window(self) -> np.ndarray | None:
        """
        Copie l'audio depuis l'ancrage, sans le retirer : le recouvrement entre
        deux passes est ce qui permet à LocalAgreement-2 de comparer.
        """
        with self.lock:
            if len(self.buffer) < seconds_to_bytes(MIN_WINDOW_S):
                return None

            # Contre-pression. Le tampon ne devrait jamais dépasser la fenêtre
            # maximale : s'il le fait, l'inférence ne suit pas le temps réel et
            # on sacrifie l'audio le plus ancien pour ne pas dériver sans fin.
            limit = seconds_to_bytes(MAX_WINDOW_S + MAX_LAG_S)
            if len(self.buffer) > limit:
                del self.buffer[: len(self.buffer) - seconds_to_bytes(MAX_WINDOW_S)]
                self.previous_words = []  # l'ancrage a sauté : plus rien n'est comparable
                self.dropped_windows += 1
                self.pending_hole = True
                log.warning("Retard > %.1f s · audio abandonné · %s", MAX_LAG_S, self.speaker_name)

            raw = bytes(self.buffer[: seconds_to_bytes(MAX_WINDOW_S)])

        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    def advance(self, seconds: float) -> None:
        """Avance l'ancrage : l'audio confirmé n'a plus à être réanalysé."""
        if seconds <= 0:
            return
        with self.lock:
            del self.buffer[: min(seconds_to_bytes(seconds), len(self.buffer))]

    def reset_anchor(self) -> None:
        """Repart de zéro (silence de fin de phrase, ou fenêtre saturée)."""
        with self.lock:
            self.buffer.clear()
        self.previous_words = []


SESSIONS: dict[str, Session] = {}
POOL: ProcessPoolExecutor | None = None
# Une file par réunion : deux inférences concurrentes sur les mêmes cœurs font
# exploser la latence des deux.
ROOM_LOCKS: dict[str, asyncio.Semaphore] = {}
_vad_warned = False


def _sdp_for(session: Session) -> str:
    return "\n".join(
        [
            "v=0",
            "o=- 0 0 IN IP4 127.0.0.1",
            "s=stark-meet-fork",
            "c=IN IP4 127.0.0.1",
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
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-protocol_whitelist", "file,rtp,udp",
            "-fflags", "+nobuffer", "-flags", "low_delay",
            "-i", session.sdp_path,
            "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-f", "s16le", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
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
    log.info("Lecture PCM terminée · %s", session.speaker_name)


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
    # Un trou abandonné est signalé : deux phrases sans rapport collées bout à
    # bout tromperaient le lecteur ET le LLM du compte-rendu.
    if session.pending_hole:
        text = "[…] " + text
        session.pending_hole = False

    session.committed_text = f"{session.committed_text} {text}".strip()
    await _emit(session, "final", text)


async def _session_loop(session: Session) -> None:
    """Boucle de transcription d'une session, cadencée à CADENCE_S."""
    loop = asyncio.get_running_loop()
    semaphore = ROOM_LOCKS.setdefault(session.meeting_id, asyncio.Semaphore(POOL_WORKERS))

    while not session.stop_flag.is_set():
        await asyncio.sleep(CADENCE_S)

        samples = session.take_window()
        if samples is None:
            continue

        if not _has_speech(samples):
            # Silence sur toute la fenêtre : ce qui restait en hypothèse ne sera
            # jamais mieux confirmé, on le fige et on repart d'un ancrage neuf.
            await _commit(session, session.previous_words)
            session.reset_anchor()
            continue

        async with semaphore:
            try:
                words = await loop.run_in_executor(POOL, _transcribe_window, samples)
            except Exception as error:
                log.error("Inférence en échec · %s: %s", session.speaker_name, error)
                continue

        session.passes += 1
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
        if session.buffered_seconds() >= MAX_WINDOW_S:
            await _commit(session, session.previous_words)
            session.reset_anchor()

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
        "Service prêt · %s %s · %d processus · fenêtre %.1f-%.1fs · cadence %.1fs",
        MODEL_SIZE, COMPUTE_TYPE, POOL_WORKERS, MIN_WINDOW_S, MAX_WINDOW_S, CADENCE_S,
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
        "callbackUrl": NODE_CALLBACK,
        "secretConfigured": bool(TRANSCRIBER_SECRET),
        "sessions": [
            {
                "speaker": s.speaker_name,
                "meetingId": s.meeting_id,
                "bufferedSeconds": round(s.buffered_seconds(), 1),
                "passes": s.passes,
                "droppedWindows": s.dropped_windows,
                "words": len(s.committed_text.split()),
            }
            for s in SESSIONS.values()
        ],
    }
