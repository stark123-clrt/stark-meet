'use client';

import { initialsOf, avatarColorFor } from '@/lib/identity';

const SIZES = {
  sm: 'w-8 h-8 text-[10px]',
  md: 'w-10 h-10 text-[12px]',
  lg: 'w-12 h-12 text-[14px]',
};

/**
 * Pastille d'initiales, colorée de façon stable par personne.
 *
 * Le même rendu est attendu partout — chat, liste des participants, tuiles
 * vidéo, tableau de bord : le template réutilise un unique composant Avatar,
 * et une divergence d'un écran à l'autre se remarque immédiatement.
 */
export default function Avatar({ name, seed, size = 'md', className = '', ring = false }) {
  const color = avatarColorFor(seed || name);

  return (
    <span
      className={`${SIZES[size]} rounded-full font-mono font-bold flex items-center justify-center flex-none ${
        ring ? 'border-2 border-surface' : ''
      } ${className}`}
      style={{ background: color.bg, color: color.fg }}
      title={name}
    >
      {initialsOf(name)}
    </span>
  );
}
