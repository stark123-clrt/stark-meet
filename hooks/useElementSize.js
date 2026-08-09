'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Mesure en continu la taille d'un élément du DOM.
 *
 * Indispensable à la grille : ses tuiles sont dimensionnées en pixels à partir
 * de l'espace réellement disponible, qui change au redimensionnement de la
 * fenêtre, à la rotation d'un téléphone, ou à l'ouverture du panneau latéral.
 * Un ResizeObserver capte tout cela, y compris les changements qui ne
 * déclenchent aucun événement `resize` sur window.
 *
 * On renvoie une *ref de rappel*, et non une ref classique observée dans un
 * useEffect : l'élément mesuré peut apparaître après le premier rendu (la
 * grille n'existe pas tant qu'aucun flux n'est arrivé). Un useEffect à
 * dépendances vides ne verrait alors qu'un `ref.current` à null et
 * n'observerait jamais rien — la taille resterait à zéro indéfiniment et plus
 * aucune tuile ne serait affichée. React appelle en revanche une ref de rappel
 * à chaque attachement et détachement du nœud.
 *
 * @returns {[Function, {width: number, height: number}]}
 */
export default function useElementSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef(null);

  const ref = useCallback((node) => {
    // Détacher l'observation précédente (démontage, ou nœud remplacé).
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!node) return;

    const applyRect = (rect) => {
      if (!rect) return;
      // Ne re-rendre que sur un changement réel : le ResizeObserver se
      // déclenche au sous-pixel près, et la grille se recalcule à chaque fois.
      setSize((previous) =>
        Math.round(previous.width) === Math.round(rect.width) &&
        Math.round(previous.height) === Math.round(rect.height)
          ? previous
          : { width: rect.width, height: rect.height }
      );
    };

    // Mesure immédiate : le premier déclenchement de l'observateur arrive au
    // rendu suivant, ce qui ferait clignoter la grille à l'apparition.
    applyRect(node.getBoundingClientRect());

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => applyRect(entries[0]?.contentRect));
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  return [ref, size];
}
