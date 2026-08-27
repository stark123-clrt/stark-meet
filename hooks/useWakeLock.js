'use client';

import { useEffect } from 'react';

/**
 * Empêche l'écran de s'éteindre tant que la réunion est en cours.
 *
 * Sur téléphone, l'écran se verrouillait au bout de trente secondes dès qu'on
 * cessait de le toucher — c'est-à-dire pendant qu'on écoute, soit l'essentiel
 * d'une réunion. Le navigateur coupe alors la caméra et met la page en veille.
 *
 * L'API n'existe pas partout (Firefox notamment) et le verrou peut être refusé
 * — batterie faible, mode économie d'énergie. Un refus est sans conséquence :
 * on retombe simplement sur le comportement d'avant.
 *
 * @param {boolean} active
 */
export default function useWakeLock(active) {
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;

    let sentinel = null;
    let released = false;

    const request = async () => {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (released) {
          lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        // Le navigateur peut relâcher de lui-même : on oublie la référence
        // pour que le retour au premier plan en redemande une neuve.
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        // Refus (batterie faible, onglet en arrière-plan, API désactivée).
      }
    };

    // Le système relâche TOUJOURS le verrou quand l'onglet passe en
    // arrière-plan, et ne le rend pas au retour. Sans cet écouteur, l'écran se
    // rendormirait dès le premier passage dans une autre application.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel && !released) request();
    };

    request();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
