'use client';

import { useEffect, useRef } from 'react';
import data from '@emoji-mart/data';
import i18n from '@emoji-mart/data/i18n/fr.json';
import Picker from '@emoji-mart/react';

/**
 * Contenu réel du sélecteur d'emojis.
 *
 * Ce fichier est volontairement séparé de EmojiPicker.js : les imports du jeu
 * de données et de la locale sont statiques, donc tout ce qu'ils tirent finit
 * dans le module qui les contient. En les isolant ici, la frontière `dynamic()`
 * posée par EmojiPicker.js les relègue dans un chunk à part, téléchargé au
 * premier clic sur le bouton emoji plutôt qu'à l'ouverture de la salle.
 *
 * `set="native"` affiche les emojis de la police du système : aucune image
 * n'est récupérée sur un CDN, ce qui compte pour un déploiement self-hosted.
 */
export default function EmojiPickerPanel({ onSelect, onClose, align = 'right' }) {
  const containerRef = useRef(null);

  // Fermeture au clic extérieur et à Échap.
  useEffect(() => {
    const handlePointerDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) onClose?.();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };

    // En phase de capture : le bouton qui a ouvert le sélecteur intercepterait
    // sinon le clic avant qu'il ne remonte jusqu'au document.
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className={`absolute bottom-full mb-2 z-50 ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      <Picker
        data={data}
        i18n={i18n}
        locale="fr"
        theme="dark"
        set="native"
        previewPosition="none"
        skinTonePosition="search"
        perLine={8}
        maxFrequentRows={2}
        onEmojiSelect={(emoji) => onSelect?.(emoji.native)}
      />
    </div>
  );
}
