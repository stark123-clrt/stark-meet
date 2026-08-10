"""
JALON 2 — Mesure du RTF de faster-whisper sur les fichiers du jalon 1.

Le RTF (Real Time Factor) est le rapport entre le temps de calcul et la durée
audio traitée. C'est LA mesure qui décide du dimensionnement de tout le module :
combien de locuteurs peuvent être transcrits simultanément sur cette machine.

⚠️ À lancer PENDANT qu'une réunion tourne, jamais sur machine au repos. Supabase
et mailcow occupent déjà 2 à 2,8 cœurs, avec des pointes où la file d'exécution
dépasse le nombre de cœurs. Une mesure à vide donne un chiffre optimiste dont on
ne peut rien conclure.

Usage :
    python measure.py /audio/fichier.wav [autres.wav ...]
    python measure.py /audio            (tous les .wav du dossier)
"""

import os
import resource
import sys
import time
import wave
from pathlib import Path

from faster_whisper import WhisperModel

# Réglages du cahier des charges §4.1, surchargeables par variable
# d'environnement : comparer plusieurs combinaisons ne doit pas obliger à
# reconstruire l'image.
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")       # `tiny` dégrade nettement le français
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")   # ÷4 mémoire, exploite AVX2/VNNI
CPU_THREADS = int(os.environ.get("WHISPER_THREADS", "2"))  # au-delà : contention avec mediasoup
# Le CDC préconisait 1 (greedy) pour économiser 40 % de CPU. Arbitrage retenu :
# la recherche par faisceau améliore nettement la transcription, et la marge
# existe pour un usage à 2-3 participants. On échange des locuteurs simultanés
# — de ~4 à ~3 — contre un transcript plus juste. Le passage à 5 locuteurs
# redeviendra possible avec une machine dédiée.
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "5"))

# Langue forcée. La détection automatique est nécessaire au multilingue, mais
# la forcer sur une réunion monolingue évite une erreur de détection et gagne
# un peu de temps.
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None

# Biaise le vocabulaire du modèle. C'est le levier le plus rentable : les noms
# propres et le jargon métier sont ce que Whisper écorche le plus, et corriger
# cela ne coûte aucun temps de calcul.
DEFAULT_PROMPT = (
    "Réunion Stark Meet. Visioconférence, mediasoup, Supabase, Coolify, "
    "agent IA, transcription, compte-rendu, développeur, ingénieur logiciel."
)
INITIAL_PROMPT = os.environ.get("WHISPER_PROMPT", DEFAULT_PROMPT) or None

# Paramètres de la fenêtre glissante du jalon 3, utilisés ici uniquement pour
# traduire un RTF en nombre de locuteurs soutenables.
WINDOW_S = 6.0
CADENCE_S = 2.0
POOL_WORKERS = 2


def audio_duration(path: Path) -> float:
    """Durée réelle du WAV, lue dans l'en-tête — pas estimée depuis la taille."""
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / float(handle.getframerate())


def peak_memory_mb() -> float:
    """Pic de mémoire résidente du processus. En Kio sous Linux."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def collect_files(args: list[str]) -> list[Path]:
    files: list[Path] = []
    for arg in args:
        path = Path(arg)
        if path.is_dir():
            files.extend(sorted(path.glob("*.wav")))
        elif path.is_file():
            files.append(path)
        else:
            print(f"⚠️  Introuvable, ignoré : {arg}")
    return files


def supported_speakers(rtf: float) -> float:
    """
    Locuteurs simultanés soutenables pour ce RTF.

    Chaque locuteur actif impose de traiter une fenêtre de WINDOW_S toutes les
    CADENCE_S. Le pool dispose de POOL_WORKERS processus, donc d'un budget de
    POOL_WORKERS × CADENCE_S secondes de calcul par cycle.
    """
    if rtf <= 0:
        return float("inf")
    return (POOL_WORKERS * CADENCE_S) / (WINDOW_S * rtf)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    files = collect_files(sys.argv[1:])
    if not files:
        print("❌ Aucun fichier .wav à traiter.")
        return 1

    print(
        f"Modèle {MODEL_SIZE} · {COMPUTE_TYPE} · {CPU_THREADS} threads · beam {BEAM_SIZE} · "
        f"langue {LANGUAGE or 'auto'} · prompt {'oui' if INITIAL_PROMPT else 'non'}"
    )
    print(f"Chargement du modèle « {MODEL_SIZE} » en {COMPUTE_TYPE}…")
    load_started = time.perf_counter()
    model = WhisperModel(
        MODEL_SIZE,
        device="cpu",
        compute_type=COMPUTE_TYPE,
        cpu_threads=CPU_THREADS,
    )
    load_seconds = time.perf_counter() - load_started
    # Mesuré à part : le chargement n'a lieu qu'une fois au démarrage du service,
    # l'inclure dans le RTF le fausserait complètement.
    print(f"Modèle chargé en {load_seconds:.1f} s\n")

    total_audio = 0.0
    total_compute = 0.0

    for path in files:
        duration = audio_duration(path)

        started = time.perf_counter()
        segments, info = model.transcribe(
            str(path),
            beam_size=BEAM_SIZE,
            language=LANGUAGE,                  # None = détection automatique
            initial_prompt=INITIAL_PROMPT,      # biaise le vocabulaire, sans coût CPU
            condition_on_previous_text=False,   # évite les boucles d'hallucination
            vad_filter=True,                    # garde-fou : Whisper hallucine sur le silence
        )
        # `transcribe` est paresseux : rien n'est calculé avant de parcourir le
        # générateur. Chronométrer sans consommer mesurerait un temps quasi nul.
        collected = list(segments)
        compute = time.perf_counter() - started

        rtf = compute / duration if duration else 0.0
        total_audio += duration
        total_compute += compute

        print(f"══ {path.name}")
        print(f"   durée audio   : {duration:.2f} s")
        print(f"   calcul        : {compute:.2f} s")
        print(f"   RTF           : {rtf:.3f}")
        print(f"   langue        : {info.language} (confiance {info.language_probability:.2f})")
        print(f"   segments      : {len(collected)}")
        for segment in collected:
            print(f"     [{segment.start:6.2f} → {segment.end:6.2f}] {segment.text.strip()}")
        print()

    global_rtf = total_compute / total_audio if total_audio else 0.0
    speakers = supported_speakers(global_rtf)

    print("═" * 60)
    print(f"Audio traité      : {total_audio:.1f} s")
    print(f"Calcul total      : {total_compute:.1f} s")
    print(f"RTF GLOBAL        : {global_rtf:.3f}")
    print(f"Pic mémoire       : {peak_memory_mb():.0f} Mio")
    print(f"Locuteurs tenus   : {speakers:.1f} en simultané")
    print("═" * 60)

    # Verdict, avec les seuils recalculés pour l'usage réel plutôt que pour la
    # cible de 30 participants du cahier des charges.
    if speakers >= 5:
        print("✅ Les 5 locuteurs du CDC tiennent. Aucune restriction.")
    elif speakers >= 3:
        print(f"✅ Cible de 3 locuteurs atteinte ({speakers:.1f}). Plafonner le pool à 3.")
    elif speakers >= 2:
        print(f"⚠️  {speakers:.1f} locuteurs seulement — en dessous de la cible de 3.")
        print("   Repli : WHISPER_BEAM=1 remonterait à ~4 au prix de la qualité.")
    elif speakers >= 1:
        print("⚠️  Un seul locuteur à la fois. Jouable en tête-à-tête, à surveiller.")
    else:
        print("❌ Whisper ne suit pas le temps réel sur cette machine.")
        print("   Pistes : WHISPER_BEAM=1, modèle `tiny`, ou machine dédiée.")

    print("\nRappel : ce chiffre ne vaut que s'il a été mesuré PENDANT une réunion.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
