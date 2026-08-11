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

    print(f"{'fenêtre':>9} {'calcul médian':>15} {'mots':>6}   verdict")
    print("─" * 60)

    baseline = None
    for window_s in WINDOWS_S:
        needed = int(window_s * SAMPLE_RATE)
        if needed > len(audio):
            print(f"{window_s:>7.1f} s   —  audio trop court, ignoré")
            continue

        samples = audio[:needed]
        timings = []
        words = 0
        for _ in range(REPEATS):
            started = time.perf_counter()
            segments, _info = model.transcribe(
                samples,
                beam_size=BEAM_SIZE,
                language=LANGUAGE,
                condition_on_previous_text=False,
                word_timestamps=True,
                vad_filter=False,
            )
            collected = list(segments)
            timings.append(time.perf_counter() - started)
            words = sum(len(segment.words or []) for segment in collected)

        median = sorted(timings)[len(timings) // 2]
        if baseline is None:
            baseline = median
            verdict = "référence"
        else:
            ratio = median / baseline
            # Si le coût suivait la durée, on attendrait ratio ≈ window/1s.
            expected = window_s / WINDOWS_S[0]
            verdict = f"×{ratio:.2f} (proportionnel : ×{expected:.0f})"

        print(f"{window_s:>7.1f} s {median:>13.2f} s {words:>6}   {verdict}")

    print("─" * 60)
    print(
        "Lecture : si les rapports restent très en dessous du « proportionnel »,\n"
        "l'encodeur domine et raccourcir la fenêtre ne gagne presque rien.\n"
        "Le levier est alors le modèle et la cadence, pas la découpe."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
