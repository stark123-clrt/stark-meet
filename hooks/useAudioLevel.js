'use client';

import { useEffect, useState } from 'react';
import { subscribeToAudioLevel } from '@/lib/audioLevel';

/**
 * Indique si le flux donné porte de la parole en ce moment.
 *
 * Toute la mesure vit dans `lib/audioLevel` : un contexte audio et une boucle
 * pour la page entière, quel que soit le nombre de tuiles.
 *
 * @param {MediaStream|null} stream
 * @param {boolean} enabled  faux quand le micro est coupé — rien à mesurer
 */
export default function useAudioLevel(stream, enabled) {
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Le remplacement de piste dans un même MediaStream ne change pas l'identité
  // de l'objet : sans ce marqueur, l'abonnement resterait accroché à la piste
  // d'avant après une coupure/reprise du micro.
  const audioTrackId = stream?.getAudioTracks()[0]?.id || null;

  useEffect(() => {
    if (!stream || !enabled || !audioTrackId) {
      setIsSpeaking(false);
      return;
    }
    return subscribeToAudioLevel(stream, setIsSpeaking);
  }, [stream, enabled, audioTrackId]);

  return isSpeaking;
}
