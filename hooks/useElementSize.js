'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Mesure en continu la taille d'un élément du DOM.
 *
 * Indispensable à la grille : ses tuiles sont dimensionnées en pixels à partir
 * de l'espace réellement disponible, qui change au redimensionnement de la
 * fenêtre, à la rotation d'un téléphone, ou à l'ouverture du panneau latéral.
 * Un ResizeObserver capte tout cela, y compris les changements qui ne
 * déclenchent aucun événement `resize` sur window.
 *
 * @returns {[React.RefObject, {width: number, height: number}]}
 */
export default function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      // Ne re-rendre que sur un changement réel : le ResizeObserver se
      // déclenche à chaque sous-pixel, et la grille se recalcule à chaque fois.
      setSize((previous) =>
        Math.round(previous.width) === Math.round(rect.width) &&
        Math.round(previous.height) === Math.round(rect.height)
          ? previous
          : { width: rect.width, height: rect.height }
      );
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
