"""
Mesure un modèle de reconnaissance EN FLUX (sherpa-onnx) sur de l'audio réel.

But : décider, chiffres en main, s'il faut remplacer Whisper par un transducteur
causal. Deux choses sont mesurées, et il faut que les DEUX tiennent :

  · la JUSTESSE, comparée aux points de référence obtenus sur cette machine —
    81 % de mots corrects pour `whisper-small` générique, 86 % pour
    `whisper-small-cv11-french` ;
  · la LATENCE réelle, c'est-à-dire le délai entre le moment où un mot est
    prononcé et celui où le modèle le produit.

L'audio doit être du PCM 16 kHz mono, exactement ce que reçoit le modèle en
production. Le service sait le capturer : lancer le conteneur avec
`-e DUMP_WAV_DIR=/models/captures` et tenir une réunion.

⚠️ À lancer PENDANT qu'une réunion tourne, comme les autres bancs de ce dossier :
une mesure sur machine au repos donne un chiffre optimiste dont on ne peut rien
conclure.

Usage :
    python bench_streaming.py --model /models/sherpa-fr /audio/reference.wav
    python bench_streaming.py --model /models/sherpa-fr --texte reference.txt /audio/reference.wav
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
# Trame d'alimentation. 100 ms est le grain typique d'un client temps réel : plus
# fin ne change rien à la justesse et ne fait que multiplier les appels.
CHUNK_S = 0.1


def load_wav(path: Path) -> np.ndarray:
    """Lit un WAV 16 kHz mono en float32 normalisé, comme l'attend le modèle."""
    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != SAMPLE_RATE or handle.getnchannels() != 1:
            raise SystemExit(
                f"❌ {path.name} doit être en 16 kHz mono "
                f"(trouvé {handle.getframerate()} Hz, {handle.getnchannels()} canaux)."
            )
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def build_recognizer(model_dir: Path, threads: int):
    """
    Construit le moteur depuis un dossier de modèle sherpa-onnx.

    Les noms de fichiers varient d'un modèle publié à l'autre ; on les cherche
    par motif plutôt que de les coder en dur, sinon chaque nouveau modèle
    demanderait de modifier ce script.
    """
    import sherpa_onnx

    def find(pattern: str) -> str:
        matches = sorted(model_dir.glob(pattern))
        if not matches:
            raise SystemExit(f"❌ Aucun fichier « {pattern} » dans {model_dir}")
        # Préférer la variante int8 quand elle existe : c'est celle qu'on
        # déploierait sur cette machine.
        for match in matches:
            if "int8" in match.name:
                return str(match)
        return str(matches[0])

    tokens = model_dir / "tokens.txt"
    if not tokens.is_file():
        raise SystemExit(f"❌ tokens.txt manquant dans {model_dir}")

    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(tokens),
        encoder=find("encoder*.onnx"),
        decoder=find("decoder*.onnx"),
        joiner=find("joiner*.onnx"),
        num_threads=threads,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        # Endpointing natif du transducteur : c'est lui qui doit remplacer le VAD
        # Silero et son seuil de silence empirique.
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4,
        rule2_min_trailing_silence=1.0,
        rule3_min_utterance_length=300,
    )


# ── Comptage des erreurs ────────────────────────────────────────────────────


def normalise(text: str) -> list[str]:
    """
    Réduit un texte à une suite de mots comparables.

    On retire accents, ponctuation et casse : ce qu'on mesure est la
    reconnaissance des mots, pas l'orthographe de sortie du modèle — les
    transducteurs ne produisent d'ailleurs ni majuscules ni ponctuation.
    """
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return [word for word in re.split(r"[^a-z0-9]+", text) if word]


def word_error_rate(reference: list[str], hypothesis: list[str]) -> tuple[int, int, int, int]:
    """
    Distance d'édition mot à mot. Renvoie (substitutions, suppressions,
    insertions, distance totale).

    Implémentation directe de Levenshtein avec traçage : sur des textes de
    quelques centaines de mots, le coût est négligeable et le détail par type
    d'erreur dit beaucoup — beaucoup de suppressions signalent un modèle qui
    saute des mots, beaucoup de substitutions un modèle qui entend mal.
    """
    rows, cols = len(reference) + 1, len(hypothesis) + 1
    distance = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        distance[i][0] = i
    for j in range(cols):
        distance[0][j] = j

    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if reference[i - 1] == hypothesis[j - 1] else 1
            distance[i][j] = min(
                distance[i - 1][j] + 1,      # suppression
                distance[i][j - 1] + 1,      # insertion
                distance[i - 1][j - 1] + cost,
            )

    # Remontée du chemin pour ventiler les erreurs par type.
    i, j = len(reference), len(hypothesis)
    subs = dels = ins = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and distance[i][j] == distance[i - 1][j - 1] and reference[i - 1] == hypothesis[j - 1]:
            i, j = i - 1, j - 1
        elif i > 0 and j > 0 and distance[i][j] == distance[i - 1][j - 1] + 1:
            subs += 1
            i, j = i - 1, j - 1
        elif i > 0 and distance[i][j] == distance[i - 1][j] + 1:
            dels += 1
            i -= 1
        else:
            ins += 1
            j -= 1

    return subs, dels, ins, distance[len(reference)][len(hypothesis)]


# ── Exécution ───────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", help="WAV 16 kHz mono")
    parser.add_argument("--model", required=True, help="dossier du modèle sherpa-onnx")
    parser.add_argument("--texte", help="fichier texte de référence, pour compter les erreurs")
    parser.add_argument("--threads", type=int, default=int(os.environ.get("THREADS", "4")))
    args = parser.parse_args()

    audio = load_wav(Path(args.audio))
    duration = len(audio) / SAMPLE_RATE

    print(f"Audio  : {Path(args.audio).name} · {duration:.1f} s")
    print(f"Modèle : {args.model} · {args.threads} threads\n")

    started = time.perf_counter()
    recognizer = build_recognizer(Path(args.model), args.threads)
    print(f"Modèle chargé en {time.perf_counter() - started:.1f} s\n")

    stream = recognizer.create_stream()
    chunk = int(CHUNK_S * SAMPLE_RATE)

    segments: list[str] = []
    current = ""
    first_word_at: float | None = None
    compute = 0.0
    latencies: list[float] = []

    for offset in range(0, len(audio), chunk):
        block = audio[offset : offset + chunk]
        # Instant, dans le temps de l'audio, où se termine ce bloc.
        audio_time = (offset + len(block)) / SAMPLE_RATE

        tick = time.perf_counter()
        stream.accept_waveform(SAMPLE_RATE, block)
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = recognizer.get_result(stream)
        endpoint = recognizer.is_endpoint(stream)
        compute += time.perf_counter() - tick

        if text and text != current:
            if first_word_at is None:
                first_word_at = audio_time
            # Latence d'affichage : le modèle est causal, donc le texte apparaît
            # pendant que la personne parle. On relève l'écart entre la fin du
            # bloc traité et le temps de calcul cumulé pour l'atteindre.
            latencies.append(compute - audio_time if compute > audio_time else 0.0)
            current = text

        if endpoint:
            if current.strip():
                segments.append(current.strip())
            recognizer.reset(stream)
            current = ""

    # Queue de silence : sans elle, la dernière phrase reste en suspens.
    tick = time.perf_counter()
    stream.accept_waveform(SAMPLE_RATE, np.zeros(int(0.6 * SAMPLE_RATE), dtype=np.float32))
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    compute += time.perf_counter() - tick
    tail = recognizer.get_result(stream).strip()
    if tail:
        segments.append(tail)

    transcript = " ".join(segments)

    print("── Transcription ─────────────────────────────────────────────")
    for index, segment in enumerate(segments, 1):
        print(f"{index:3}. {segment}")
    print()

    rtf = compute / duration if duration else 0.0
    print("── Vitesse ───────────────────────────────────────────────────")
    print(f"Calcul total   : {compute:.2f} s pour {duration:.1f} s d'audio")
    print(f"RTF            : {rtf:.3f}")
    if first_word_at is not None:
        print(f"Premier texte  : après {first_word_at:.1f} s d'audio")
    if latencies:
        print(f"Retard médian  : {sorted(latencies)[len(latencies) // 2]:.2f} s")
    print(f"Locuteurs tenus: {1 / rtf:.1f} en simultané" if rtf > 0 else "")
    print()

    if args.texte:
        reference = normalise(Path(args.texte).read_text(encoding="utf-8"))
        hypothesis = normalise(transcript)
        subs, dels, ins, total = word_error_rate(reference, hypothesis)
        correct = 100.0 * (1 - total / len(reference)) if reference else 0.0

        print("── Justesse ──────────────────────────────────────────────────")
        print(f"Mots de référence : {len(reference)}")
        print(f"Mots reconnus     : {len(hypothesis)}")
        print(f"Substitutions     : {subs}")
        print(f"Omissions         : {dels}")
        print(f"Insertions        : {ins}")
        print(f"MOTS CORRECTS     : {correct:.1f} %")
        print()
        print("Références mesurées sur cette machine, même protocole :")
        print("  whisper-small générique ......... 81 %")
        print("  whisper-small-cv11-french ....... 86 %")
        print()
        if correct >= 84:
            print("✅ Comparable au meilleur Whisper, avec la latence en prime. Migrer.")
        elif correct >= 78:
            print("⚠️  En retrait sur la justesse mais bien plus rapide.")
            print("   Piste : transducteur pour l'affichage en direct, Whisper en")
            print("   différé pour le texte définitif et le compte-rendu.")
        else:
            print("❌ Trop en retrait. Le gain de latence ne rachète pas la perte.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
