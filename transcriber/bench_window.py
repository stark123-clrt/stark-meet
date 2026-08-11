"""
Mesure le coût réel d'une passe selon la longueur de fenêtre et le modèle.

But : trancher une question de dimensionnement qui décide de la latence
ressentie, avec des chiffres de CETTE machine plutôt qu'avec des estimations.

L'hypothèse à vérifier est que l'encodeur de Whisper travaille sur une fenêtre
de 30 s quelle que soit la durée fournie (les entrées plus courtes sont
complétées par du silence). Si c'est vrai, le temps de calcul doit être
largement INSENSIBLE à la longueur de fenêtre — et découper plus fin pour
gagner en latence ne sert alors à rien.

⚠️ À lancer PENDANT qu'une réunion tourne, comme measure.py : une mesure sur
machine au repos donne un chiffre optimiste dont on ne peut rien conclure.

Usage :
    python bench_window.py /audio/fichier.wav
    WHISPER_MODEL=base python bench_window.py /audio/fichier.wav
"""

import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
CPU_THREADS = int(os.environ.get("WHISPER_THREADS", "2"))
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "1"))
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None

SAMPLE_RATE = 16000
WINDOWS_S = [1.0, 2.0, 3.0, 5.0, 8.0, 12.0]
REPEATS = 3  # la première passe est toujours plus lente (caches froids)


def load_pcm(path: Path) -> np.ndarray:
    """Lit un WAV mono 16 kHz en float32, comme le service le fait."""
    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != SAMPLE_RATE or handle.getnchannels() != 1:
            print(
                f"⚠️  {path.name} n'est pas en 16 kHz mono "
                f"({handle.getframerate()} Hz, {handle.getnchannels()} canaux) — "
                "les chiffres resteront comparables entre eux."
            )
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"❌ Introuvable : {path}")
        return 1

    audio = load_pcm(path)
    duration = len(audio) / SAMPLE_RATE
    print(f"Fichier {path.name} · {duration:.1f} s d'audio")
    print(f"Modèle {MODEL_SIZE} · {COMPUTE_TYPE} · {CPU_THREADS} threads · beam {BEAM_SIZE}\n")

    model = WhisperModel(
        MODEL_SIZE, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=CPU_THREADS
    )

    # Passe de chauffe, exclue des mesures.
    list(model.transcribe(audio[: SAMPLE_RATE * 2], beam_size=BEAM_SIZE, language=LANGUAGE)[0])

    def run_once(samples: np.ndarray, chunk_length: int | None) -> tuple[float, int]:
        """Une transcription chronométrée. `chunk_length=None` = défaut (30 s)."""
        extra = {} if chunk_length is None else {"chunk_length": chunk_length}
        started = time.perf_counter()
        segments, _info = model.transcribe(
            samples,
            beam_size=BEAM_SIZE,
            language=LANGUAGE,
            condition_on_previous_text=False,
            word_timestamps=True,
            vad_filter=False,
            **extra,
        )
        collected = list(segments)
        elapsed = time.perf_counter() - started
        return elapsed, sum(len(segment.words or []) for segment in collected)

    def median_of(samples: np.ndarray, chunk_length: int | None) -> tuple[float, int]:
        results = [run_once(samples, chunk_length) for _ in range(REPEATS)]
        timings = sorted(result[0] for result in results)
        return timings[len(timings) // 2], results[-1][1]

    # ── Test 1 : le coût dépend-il de la longueur de fenêtre ? ──────────────
    print("TEST 1 — coût selon la longueur de fenêtre (complètement à 30 s par défaut)\n")
    print(f"{'fenêtre':>9} {'calcul médian':>15} {'mots':>6}   verdict")
    print("─" * 64)

    baseline = None
    for window_s in WINDOWS_S:
        needed = int(window_s * SAMPLE_RATE)
        if needed > len(audio):
            print(f"{window_s:>7.1f} s   —  audio trop court, ignoré")
            continue

        median, words = median_of(audio[:needed], None)
        if baseline is None:
            baseline = median
            verdict = "référence"
        else:
            # Si le coût suivait la durée, on attendrait ratio ≈ window/1s.
            verdict = f"×{median / baseline:.2f} (proportionnel : ×{window_s / WINDOWS_S[0]:.0f})"

        print(f"{window_s:>7.1f} s {median:>13.2f} s {words:>6}   {verdict}")

    print("─" * 64)
    print(
        "Lecture : des rapports proches de ×1 confirment que l'encodeur domine\n"
        "et que raccourcir la fenêtre ne gagne presque rien.\n"
    )

    # ── Test 2 : peut-on éviter le remplissage jusqu'à 30 s ? ───────────────
    # C'est LA question qui décide si la transcription en direct est possible
    # sur cette machine. Si `chunk_length` réduit vraiment le travail de
    # l'encodeur, le coût d'une passe chute proportionnellement.
    window_s = 5.0
    needed = int(window_s * SAMPLE_RATE)
    if needed > len(audio):
        print("TEST 2 ignoré — audio plus court que 5 s.")
        return 0

    samples = audio[:needed]
    print(f"TEST 2 — fenêtre de {window_s:.0f} s, en faisant varier le remplissage\n")
    print(f"{'chunk_length':>13} {'calcul médian':>15} {'mots':>6}   verdict")
    print("─" * 64)

    try:
        reference, words = median_of(samples, 30)
    except TypeError:
        print("  Le paramètre `chunk_length` n'existe pas dans cette version de")
        print("  faster-whisper — ce levier est indisponible, il faudra passer")
        print("  par un modèle plus petit. Mettre faster-whisper à jour, ou")
        print("  choisir `tiny`.")
        return 0

    print(f"{'30 s (défaut)':>13} {reference:>13.2f} s {words:>6}   référence")

    for chunk_length in (10, 6):
        try:
            median, words = median_of(samples, chunk_length)
        except Exception as error:  # valeur refusée par le modèle
            print(f"{chunk_length:>11} s   — refusé : {error}")
            continue
        gain = reference / median if median else 0
        print(f"{chunk_length:>11} s {median:>13.2f} s {words:>6}   {gain:.1f}× plus rapide")

    print("─" * 64)
    print(
        "Lecture : un gain net (2× ou plus) rend la transcription en direct\n"
        "jouable avec le modèle actuel. Sinon, il faut descendre en taille de\n"
        "modèle, et le compromis se joue sur la qualité du français."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
