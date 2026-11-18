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

# Moteur unique : sherpa-onnx, en local. L'audio ne quitte jamais la machine.
MODEL_DIR = os.environ.get("SHERPA_MODEL_DIR", "/models/sherpa-fr")
NUM_THREADS = int(os.environ.get("SHERPA_THREADS", "2"))

# Recherche par faisceau plutôt que glouton.
#
# Le décodage glouton retient le meilleur jeton à chaque pas et ne revient
# jamais dessus : une erreur au début d'un mot entraîne tout le reste. Observé
# en production — « en visioconférence » rendu « envie aux conférences », « il
# fait beau ce matin » rendu « il fait beaucier matin ». Le faisceau garde
# plusieurs hypothèses en parallèle et tranche plus tard, ce qui rattrape
# exactement ce type de dérive.
#
# ⚠️ C'est aussi la SEULE méthode qui accepte le biaisage contextuel : les mots
# prioritaires ci-dessous sont ignorés en décodage glouton.
DECODING = os.environ.get("SHERPA_DECODING", "modified_beam_search")
MAX_ACTIVE_PATHS = int(os.environ.get("SHERPA_BEAM", "4"))

# Biaisage contextuel. Le score pousse le décodeur vers ces mots sans les
# imposer ; trop haut, il les ferait apparaître là où personne ne les a dits.
HOTWORDS_SCORE = float(os.environ.get("HOTWORDS_SCORE", "1.5"))
HOTWORDS_EXTRA = os.environ.get("HOTWORDS", "")

# Lexique : le dictionnaire français complet, utilisé comme contrainte de
# vocabulaire pendant la recherche par faisceau (graphe de contexte).
#
# Mesuré sur une réunion réelle, référence Meta (cellule de test Kaggle) :
# sans contrainte WER 0,359 · 24 termes ciblés 0,369 (ça dégrade) ·
# dictionnaire complet 0,350. Ce n'est pas un biais de domaine : les erreurs du
# modèle produisent souvent des NON-MOTS (« BARAMETRE », « PRENDSAIS »), qui ne
# reçoivent aucun bonus, si bien que le décodage est poussé vers du vrai français.
#
# « auto » : `lexique.txt` du dossier du modèle s'il existe · « non » : désactivé ·
# sinon un chemin. Le score s'applique par jeton, comme `SCORE` dans la cellule
# de test.
#
# ⚠️ Avec un lexique, plus de mots prioritaires PAR FLUX (le nom du locuteur) :
# sherpa-onnx reconstruirait alors le graphe entier — des centaines de milliers
# de mots — à chaque ouverture de flux. Le graphe est construit UNE fois au
# démarrage et partagé par tous les flux. `HOTWORDS` reste pris en compte : ses
# mots sont ajoutés au lexique avec leur propre score.
LEXIQUE = os.environ.get("SHERPA_LEXIQUE", "auto")
LEXIQUE_SCORE = float(os.environ.get("SHERPA_LEXIQUE_SCORE", "0.5"))
LEXIQUE_ACTIF = False
LEXIQUE_FICHIER = None
LEXIQUE_ENTREES = 0

# Endpointing du transducteur. Ces trois règles remplacent le seuil de silence
# du VAD : la première clôt sur un long silence, la deuxième sur un silence plus
# court APRÈS avoir décodé quelque chose, la troisième borne les monologues.
#
# Abaissées après observation : à 1,0 s, deux phrases séparées par une pause
# courte étaient fusionnées en une seule — « il fait beau ce matin et je vais
# travailler sur mon projet les réunions en visioconférence ».
RULE1_SILENCE = float(os.environ.get("SHERPA_RULE1", "1.8"))
RULE2_SILENCE = float(os.environ.get("SHERPA_RULE2", "0.6"))
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

# Silence reconstruit au maximum d'un coup. Au-delà, on n'injecte RIEN.
#
# ⚠️ Un transducteur nourri de zéros finit par émettre des jetons sans signal —
# observé en production : entre deux prises de parole, le modèle affiné sur
# VoxPopuli régurgitait son vocabulaire d'entraînement (« la proposition de la
# France », « un mois de continisations »). Combler un micro-trou de gigue reste
# utile ; combler deux secondes de silence fabrique des hallucinations.
#
# Ne pas combler ne dérègle pas l'ordre d'affichage : `spokenAt` est pris sur
# l'horloge murale à la publication, pas sur le compte d'échantillons.
MAX_GAP_S = float(os.environ.get("MAX_GAP_S", "0.5"))

# ── Porte de voix ───────────────────────────────────────────────────────────
#
# Le modèle produit du texte sur le souffle du micro et le bruit de fond — il a
# été affiné sur des corpus où quelqu'un parle en permanence, et n'a donc jamais
# appris à ne rien émettre.
#
# ⚠️ RÈGLE ESSENTIELLE : la porte filtre la PUBLICATION, jamais l'alimentation.
# Le flux sherpa-onnx doit continuer de recevoir tout l'audio, silence compris :
# c'est ce silence qui déclenche son endpointing. Cesser de le nourrir
# supprimerait toute phrase confirmée.
#
# Silero plutôt qu'un seuil d'énergie : un ventilateur dépasse un seuil fixe
# qu'une voix faible ne franchit pas. Silero distingue la parole du bruit, pas le
# fort du faible, et ne demande donc pas de réglage par pièce ni par micro.
VAD_ENABLED = os.environ.get("VAD_ENABLED", "true").lower() == "true"
VAD_MODEL = os.environ.get("VAD_MODEL", "/models/silero_vad.onnx")
VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))

# Durée pendant laquelle on continue de publier après la dernière parole
# détectée. Les derniers mots d'une phrase arrivent souvent après que la
# personne s'est tue : une fenêtre trop courte les couperait.
VAD_HOLD_S = float(os.environ.get("VAD_HOLD_S", "2.5"))

# Silero v5 à 16 kHz travaille par fenêtres de 512 échantillons, soit 32 ms. On
# accumule donc avant de l'appeler.
VAD_WINDOW = 512

# Mots minimum pour qu'une phrase soit publiée.
#
# Les hallucinations sortent en un ou deux mots isolés — « Tout », « La »,
# « Madame », « Dans ». Ce filtre les élimine d'un coup.
#
# ⚠️ Il a un coût réel : « Oui », « D'accord », « Merci », « Exactement » sont
# des réponses légitimes en réunion, et ce seuil les supprime aussi. Le mettre à
# 1 le désactive.
MIN_FINAL_WORDS = int(os.environ.get("MIN_FINAL_WORDS", "3"))

# Cadence maximale d'émission des hypothèses. `get_result` renvoie le texte
# complet du segment en cours à CHAQUE trame : sans limitation, on enverrait
# cinquante messages par seconde et par locuteur, contenant presque toujours la
# même chose.
PARTIAL_INTERVAL_S = float(os.environ.get("PARTIAL_INTERVAL_S", "0.25"))

DUMP_WAV_DIR = os.environ.get("DUMP_WAV_DIR", "")


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
    global RECOGNIZER, LEXIQUE_ACTIF, LEXIQUE_FICHIER, LEXIQUE_ENTREES
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

    base = dict(
        tokens=os.path.join(directory, "tokens.txt"),
        encoder=find("encoder*.onnx"),
        decoder=find("decoder*.onnx"),
        joiner=find("joiner*.onnx"),
        num_threads=NUM_THREADS,
        sample_rate=TARGET_RATE,
        feature_dim=80,
        decoding_method=DECODING,
        max_active_paths=MAX_ACTIVE_PATHS,
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=RULE1_SILENCE,
        rule2_min_trailing_silence=RULE2_SILENCE,
        rule3_min_utterance_length=RULE3_MAX_FRAMES,
    )

    # Sans `bpe.vocab`, sherpa-onnx ne sait pas découper un mot prioritaire en
    # jetons BPE : le lexique est alors impossible, et les mots par flux aussi.
    vocab = os.path.join(directory, "bpe.vocab")
    bpe = dict(modeling_unit="bpe", bpe_vocab=vocab) if os.path.isfile(vocab) else {}

    lexique = _lexique_path()
    if lexique and DECODING != "modified_beam_search":
        log.warning("Lexique ignoré : il exige SHERPA_DECODING=modified_beam_search")
        lexique = None
    if lexique and not bpe:
        log.warning("Lexique ignoré : bpe.vocab absent de %s", directory)
        lexique = None

    if lexique:
        started = time.perf_counter()
        fichier, LEXIQUE_ENTREES = _lexique_avec_extras(lexique)
        try:
            RECOGNIZER = sherpa_onnx.OnlineRecognizer.from_transducer(
                **base, **bpe, hotwords_file=fichier, hotwords_score=LEXIQUE_SCORE,
            )
            LEXIQUE_ACTIF = True
            LEXIQUE_FICHIER = lexique
            log.info(
                "Lexique chargé · %s · %d entrées · score %.2f · %.1f s "
                "(mots prioritaires par flux désactivés)",
                lexique, LEXIQUE_ENTREES, LEXIQUE_SCORE, time.perf_counter() - started,
            )
        except TypeError as error:
            # sherpa-onnx trop ancien pour `modeling_unit` / `bpe_vocab`.
            log.warning("Lexique non pris en charge par cette version : %s", error)
            LEXIQUE_ENTREES = 0

    if not LEXIQUE_ACTIF:
        try:
            RECOGNIZER = sherpa_onnx.OnlineRecognizer.from_transducer(
                **base, **bpe, hotwords_score=HOTWORDS_SCORE,
            )
        except TypeError:
            RECOGNIZER = sherpa_onnx.OnlineRecognizer.from_transducer(
                **base, hotwords_score=HOTWORDS_SCORE,
            )

    log.info(
        "Modèle chargé · %s · %d threads · %s · faisceau %d · lexique %s",
        directory, NUM_THREADS, DECODING, MAX_ACTIVE_PATHS,
        "oui" if LEXIQUE_ACTIF else "non",
    )


def _lexique_path() -> str | None:
    """Résout SHERPA_LEXIQUE : un fichier existant, ou None."""
    value = LEXIQUE.strip()
    if value.lower() in ("", "non", "none", "false", "0"):
        return None
    if value.lower() == "auto":
        path = os.path.join(MODEL_DIR, "lexique.txt")
        return path if os.path.isfile(path) else None
    if not os.path.isfile(value):
        log.warning("Lexique introuvable : %s — démarrage sans lexique", value)
        return None
    return value


def _lexique_avec_extras(path: str) -> tuple[str, int]:
    """
    Renvoie le fichier à donner à sherpa-onnx et son nombre d'entrées.

    Les mots de `HOTWORDS` (séparés par « / ») y sont ajoutés avec leur propre
    score, `HOTWORDS_SCORE` : ce sont des termes que l'on veut vraiment favoriser,
    pas une simple contrainte de vocabulaire. Le format sherpa-onnx place le score
    en dernier élément de la ligne, après « : ».
    """
    with open(path, encoding="utf-8") as handle:
        entries = sum(1 for line in handle if line.strip())

    extras = [w.strip().upper() for w in HOTWORDS_EXTRA.replace("\n", "/").split("/")]
    extras = [w for w in extras if w and ":" not in w]
    if not extras:
        return path, entries

    import tempfile

    merged = os.path.join(tempfile.gettempdir(), "stark-lexique.txt")
    with open(path, encoding="utf-8") as source, open(merged, "w", encoding="utf-8") as out:
        for line in source:
            if line.strip():
                out.write(line if line.endswith("\n") else line + "\n")
        for word in extras:
            out.write(f"{word} :{HOTWORDS_SCORE}\n")
    return merged, entries + len(extras)


_vad_warned = False


def make_vad():
    """
    Détecteur de voix Silero, ou None s'il est indisponible.

    Le repli est délibéré : un fichier de modèle manquant ne doit pas empêcher
    de transcrire. Sans porte, on retombe simplement sur le comportement
    précédent — du texte parasite, mais du texte.
    """
    global _vad_warned
    if not VAD_ENABLED:
        return None

    try:
        import sherpa_onnx

        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = VAD_MODEL
        config.silero_vad.threshold = VAD_THRESHOLD
        config.silero_vad.min_silence_duration = 0.25
        config.sample_rate = TARGET_RATE
        return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=10)
    except Exception as error:
        if not _vad_warned:
            _vad_warned = True
            log.warning(
                "Porte de voix désactivée (%s introuvable ou illisible) : %s",
                VAD_MODEL, error,
            )
        return None


_hotwords_warned = False


def make_stream(speaker_name: str):
    """
    Crée le flux de reconnaissance, en y injectant les mots prioritaires.

    Le nom du locuteur est celui que le modèle écorche le plus : il est prononcé
    souvent et n'appartient pas au vocabulaire courant. On le connaît dès
    l'ouverture du flux, autant s'en servir — c'est gratuit et ça ne demande
    aucun réentraînement.

    L'API des mots prioritaires varie selon les versions de sherpa-onnx, d'où le
    repli sur un flux ordinaire plutôt qu'un échec de session.

    Avec un lexique, le flux reprend simplement le graphe partagé : des mots par
    flux forceraient sherpa-onnx à reconstruire le lexique entier ici.
    """
    global _hotwords_warned

    if LEXIQUE_ACTIF:
        return RECOGNIZER.create_stream()

    words = [w for w in [speaker_name, HOTWORDS_EXTRA] if w and w.strip()]
    if not words or DECODING != "modified_beam_search":
        return RECOGNIZER.create_stream()

    hotwords = "\n".join(w.strip().upper() for w in words)
    try:
        return RECOGNIZER.create_stream(hotwords=hotwords)
    except Exception as error:
        if not _hotwords_warned:
            _hotwords_warned = True
            log.warning("Mots prioritaires non pris en charge par cette version : %s", error)
        return RECOGNIZER.create_stream()


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
    la part la moins utile à la lecture.

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
    # Cumuls du rééchantillonnage. Seul le rapport SUR LA DURÉE a un sens : un
    # rééchantillonneur à état retient une latence de filtre au démarrage et
    # produit par à-coups, si bien qu'une trame isolée peut rendre 0 ou 490
    # échantillons sans que rien ne soit anormal.
    resample_in: int = 0
    resample_out: int = 0
    suppressed: int = 0
    vad_suppressed: int = 0
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

    stream = make_stream(session.speaker_name)

    pending: dict[int, tuple[int, bytes]] = {}
    expected_seq: int | None = None
    last_ts: int | None = None
    # Durée de la dernière trame réellement décodée. Sert à dimensionner la
    # dissimulation de perte : voir decode_frame.
    last_frame_samples = FRAME_SAMPLES_20MS
    last_text = ""
    last_sent = 0.0

    # Porte de voix. `vad_buffer` accumule jusqu'à la fenêtre attendue par
    # Silero ; `last_speech` retient l'instant de la dernière parole détectée.
    vad = make_vad()
    vad_buffer = np.zeros(0, dtype=np.float32)
    last_speech = 0.0

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

    def voice_recently() -> bool:
        """Vrai si de la parole a été détectée dans la fenêtre de rétention."""
        if vad is None:
            return True  # sans détecteur, on ne retient rien
        return (time.monotonic() - last_speech) <= VAD_HOLD_S

    def publish(kind: str, text: str) -> None:
        # ⚠️ Seule la publication est filtrée. Le modèle a déjà reçu cet audio et
        # continuera d'en recevoir : son endpointing reste intact.
        if not voice_recently():
            session.vad_suppressed += 1
            return

        payload = {
            "type": kind,
            "text": prettify(text),
            "producerId": session.producer_id,
            "participantId": session.participant_id,
            "displayName": session.speaker_name,
            # Instant de prononciation : c'est la clé de tri qui remet les
            # locuteurs dans l'ordre dans le fil de la conversation.
            "spokenAt": round(time.time(), 3),
            "segmentId": f"{session.producer_id}-{session.finals}",
        }
        # Traversée de frontière : ce code tourne dans un thread, la file est
        # asyncio. `call_soon_threadsafe` est le seul passage sûr.
        loop.call_soon_threadsafe(results.put_nowait, payload)

    def watch_voice(samples: np.ndarray) -> None:
        """Alimente le détecteur de voix, par fenêtres de la taille attendue."""
        nonlocal vad_buffer, last_speech
        if vad is None:
            return
        try:
            vad_buffer = np.concatenate([vad_buffer, samples])
            while len(vad_buffer) >= VAD_WINDOW:
                vad.accept_waveform(vad_buffer[:VAD_WINDOW])
                vad_buffer = vad_buffer[VAD_WINDOW:]
            if vad.is_speech_detected():
                last_speech = time.monotonic()
        except Exception as error:
            log.warning("Porte de voix en erreur, désactivée · %s: %s",
                        session.speaker_name, error)
            _disable_vad()

    def _disable_vad() -> None:
        nonlocal vad
        vad = None

    def emit(kind: str, text: str) -> None:
        """
        Filtre et publie une sortie du moteur : seuil de mots pour les phrases
        confirmées, limitation de cadence pour les hypothèses.
        """
        nonlocal last_text, last_sent

        text = (text or "").strip()
        if not text:
            return
        now = time.monotonic()

        if kind == "final":
            words = text.split()
            if len(words) >= MIN_FINAL_WORDS:
                session.finals += 1
                publish("final", text)
            else:
                # Compté plutôt que jeté en silence : si ce nombre explose, c'est
                # que le seuil supprime de vraies réponses courtes et non des
                # hallucinations.
                session.suppressed += 1
            last_text = ""
            last_sent = now
            return

        if text != last_text and now - last_sent >= PARTIAL_INTERVAL_S:
            last_text = text
            last_sent = now
            publish("partial", text)

    def feed(samples: np.ndarray) -> None:
        """Injecte du PCM 16 kHz dans le moteur et récolte ce qui en sort."""
        # Le détecteur observe le même audio, en parallèle et sans le retenir.
        watch_voice(samples)
        session.audio_seconds += len(samples) / TARGET_RATE

        started = time.perf_counter()
        stream.accept_waveform(TARGET_RATE, samples)
        while RECOGNIZER.is_ready(stream):
            RECOGNIZER.decode_stream(stream)
        text = RECOGNIZER.get_result(stream)
        endpoint = RECOGNIZER.is_endpoint(stream)
        session.compute_seconds += time.perf_counter() - started

        if endpoint:
            emit("final", text)
            RECOGNIZER.reset(stream)
        elif text:
            emit("partial", text)

    def decode_frame(payload: bytes | None) -> None:
        """Décode une trame, ou la reconstruit si elle est perdue."""
        nonlocal wav, last_frame_samples
        try:
            if payload is None:
                # ⚠️ Dissimulation de perte : ici `frame_size` n'est PAS une
                # capacité mais la longueur RÉELLEMENT produite. Passer
                # MAX_FRAME_SAMPLES fabriquait 120 ms d'audio pour combler une
                # trame de 20 ms — six fois trop, injecté à chaque paquet perdu.
                # On reproduit donc la durée de la dernière trame connue.
                raw = decoder.decode(None, last_frame_samples, decode_fec=False)
                session.lost_frames += 1
            else:
                # Avec une charge utile, `frame_size` est bien une capacité :
                # libopus ne renvoie que ce qu'il a décodé.
                raw = decoder.decode(payload, MAX_FRAME_SAMPLES)
                session.decoded_frames += 1
                last_frame_samples = len(raw) // 2  # 16 bits, mono
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
        session.resample_in += len(pcm)
        session.resample_out += len(resampled)
        if len(resampled):
            feed(np.ascontiguousarray(resampled, dtype=np.float32))

    def insert_silence(seconds: float) -> None:
        """
        Comble un micro-trou de gigue — et seulement lui.

        Au-delà de MAX_GAP_S on n'injecte rien : nourrir le modèle de silence
        prolongé le fait halluciner, et c'est ce qui produisait du texte alors
        que personne ne parlait.
        """
        if seconds <= 0 or seconds > MAX_GAP_S:
            return
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
        elif last_ts is not None:
            # ⚠️ L'horloge doit avancer même sur une trame perdue. Sans ça, le
            # paquet suivant croit qu'il manque du temps et insert_silence en
            # rajoute — alors que la dissimulation vient déjà de produire cet
            # audio. Le flux se dilatait donc à chaque perte.
            last_ts = (last_ts + FRAME_SAMPLES_20MS) & 0xFFFFFFFF
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
        emit("final", RECOGNIZER.get_result(stream))
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


# ── API ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="stark-streaming")


@app.on_event("startup")
async def _startup() -> None:
    load_recognizer()


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

    async def sender() -> None:
        """
        Sortie des résultats. Le thread de travail n'a pas de boucle asyncio : il
        dépose hypothèses et phrases confirmées dans cette file, et cette
        coroutine — seule en contexte async — les renvoie telles quelles.
        """
        while True:
            payload = await results.get()
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
        "maxActivePaths": MAX_ACTIVE_PATHS,
        "hotwordsScore": HOTWORDS_SCORE,
        "vad": {
            "enabled": VAD_ENABLED,
            "model": VAD_MODEL,
            "threshold": VAD_THRESHOLD,
            "holdSeconds": VAD_HOLD_S,
        },
        "lexique": {
            "actif": LEXIQUE_ACTIF,
            "fichier": LEXIQUE_FICHIER,
            "entrees": LEXIQUE_ENTREES,
            "score": LEXIQUE_SCORE,
        },
        "activeSessions": len(SESSIONS),
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
                # LE chiffre décisif : doit valoir 3.000 sur la durée. Une valeur
                # proche de 2 signifierait que le modèle reçoit un signal 1,5 fois
                # trop long, donc de la parole ralentie ; proche de 1, du 48 kHz
                # étiqueté 16 kHz.
                "resampleRatio": round(s.resample_in / s.resample_out, 3) if s.resample_out else None,
                "resampleIn": s.resample_in,
                "resampleOut": s.resample_out,
                "audioSeconds": round(s.audio_seconds, 1),
                "rtf": round(s.rtf, 3),
                "finals": s.finals,
                # Segments écartés parce que trop courts. Un chiffre du même
                # ordre que `finals` signalerait un seuil trop haut.
                "suppressed": s.suppressed,
                # Sorties retenues faute de voix détectée. À comparer à `finals` :
                # si les deux montent au même rythme, le seuil Silero coupe de la
                # vraie parole et il faut le baisser.
                "vadSuppressed": s.vad_suppressed,
                "queued": s.packets.qsize(),
            }
            for s in SESSIONS.values()
        ],
    }
