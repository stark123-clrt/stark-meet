'use client';

import dynamic from 'next/dynamic';

/**
 * Frontière de chargement paresseux du sélecteur d'emojis.
 *
 * Ce fichier ne contient volontairement aucun import du jeu de données : tout
 * le poids (données emoji + locale + emoji-mart, ~1,5 Mo) vit dans
 * EmojiPickerPanel.js, que `dynamic()` relègue dans un chunk séparé. Le
 * téléchargement n'a lieu qu'au premier clic sur le bouton emoji ; l'entrée
 * dans une réunion n'en paie rien.
 */
const EmojiPicker = dynamic(() => import('./EmojiPickerPanel'), {
  ssr: false,
  loading: () => (
    <div className="absolute bottom-full mb-2 right-0 z-50 w-[340px] h-[420px] rounded-lg bg-ink-850 border border-ink-700 flex items-center justify-center">
      <span className="text-ink-500 text-sm">Chargement des emojis…</span>
    </div>
  ),
});

export default EmojiPicker;
