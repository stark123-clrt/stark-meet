/**
 * useTranscript — abonnement au transcript porté par le canal de contrôle.
 *
 * L'état vit dans useRoomChannel (voir le commentaire « Transcription » là-bas :
 * course au démarrage et coût des rendus). Ce hook n'est que le pont entre cet
 * émetteur et un composant React, de sorte que seul le panneau qui affiche le
 * transcript se redessine à chaque hypothèse.
 */

'use client';

import { useEffect, useState } from 'react';

const EMPTY = { finals: [], partials: [] };

export default function useTranscript(channel) {
  const [transcript, setTranscript] = useState(EMPTY);

  useEffect(() => {
    if (!channel?.subscribeTranscript) return undefined;

    // Lecture immédiate : l'historique a pu arriver avant que ce composant ne
    // soit monté (panneau ouvert après coup, ou rechargement de page).
    setTranscript(channel.getTranscript());
    return channel.subscribeTranscript(setTranscript);
  }, [channel]);

  return transcript;
}
