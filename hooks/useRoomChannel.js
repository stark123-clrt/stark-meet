/**
 * useRoomChannel — canal de contrôle temps réel d'une réunion.
 *
 * Supabase reste la base de données (source de vérité persistante), mais tout
 * ce qui doit être vu « en direct » — demande d'admission, admission,
 * exclusion, verrouillage, mute forcé, chat — transite par le serveur
 * Socket.io. Supabase Realtime n'est pas utilisable ici : son websocket n'est
 * pas exposé sur l'instance self-hosted, si bien qu'aucun événement
 * n'arrivait et que chaque participant devait rafraîchir sa page à la main.
 *
 * Le canal s'ouvre dès l'arrivée sur /room/<code>, y compris quand on est
 * bloqué en salle d'attente : c'est ce qui permet d'être admis sans recharger.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import io from 'socket.io-client';

const MEDIASOUP_SERVER_URL = process.env.NEXT_PUBLIC_MEDIASOUP_URL || 'http://localhost:3001';

// Fenêtre d'affichage du transcript, alignée sur celle du serveur. À 400, elle
// se remplissait en une heure de conversation et le panneau paraissait figé,
// alors qu'il faisait défiler silencieusement les plus anciennes lignes.
//
// Au-delà de quelques milliers de lignes affichées, c'est le navigateur qui
// peinera à tout redessiner, pas la mémoire. Si ça arrive, la réponse sera
// l'affichage virtualisé, pas un plafond plus bas.
const TRANSCRIPT_LIMIT = 20000;

export default function useRoomChannel({
  meetingId,
  participantId,
  userId,
  displayName,
  isHost,
  onDirty,
  onParticipantUpdated,
  onMeetingUpdated,
  onEjected,
  onForceMuted,
}) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  // Les handlers sont lus via des refs : le composant parent en recrée à
  // chaque rendu, et les mettre en dépendances de l'effet rouvrirait la
  // connexion socket en boucle.
  const handlersRef = useRef({});
  handlersRef.current = { onDirty, onParticipantUpdated, onMeetingUpdated, onEjected, onForceMuted };

  const identityRef = useRef({});
  identityRef.current = { meetingId, participantId, userId, displayName, isHost };

  // ── Transcription ─────────────────────────────────────────────────────────
  // Le transcript est tenu ici, dans un ref doublé d'un petit émetteur, et non
  // en état React. Deux raisons :
  //
  //  1. Course au démarrage. Le serveur envoie `control:transcript-state` en
  //     réponse immédiate à `control:join`, donc avant que React n'ait pu
  //     remonter jusqu'à un composant enfant abonné : un écouteur posé plus
  //     tard manquerait l'historique. Ici l'écouteur est posé dans le même
  //     effet que la connexion.
  //  2. Rendus. Une hypothèse arrive toutes les 2 s par locuteur. En état
  //     React à ce niveau, chacune redessinerait toute la page réunion,
  //     tuiles vidéo comprises. Seul le panneau abonné se redessine.
  const transcriptRef = useRef({ finals: [], partials: [] });
  const transcriptSubscribers = useRef(new Set());
  const transcriptSeq = useRef(0);

  const publishTranscript = useCallback((next) => {
    transcriptRef.current = next;
    transcriptSubscribers.current.forEach((notify) => notify(next));
  }, []);

  const withId = useCallback((segment) => ({ ...segment, id: `t${(transcriptSeq.current += 1)}` }), []);

  const subscribeTranscript = useCallback((notify) => {
    transcriptSubscribers.current.add(notify);
    return () => transcriptSubscribers.current.delete(notify);
  }, []);

  const getTranscript = useCallback(() => transcriptRef.current, []);

  useEffect(() => {
    if (!meetingId) return;

    const socket = io(MEDIASOUP_SERVER_URL, {
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
    });
    socketRef.current = socket;

    const announce = () => {
      socket.emit('control:join', identityRef.current, (response) => {
        if (response?.forceMuted) handlersRef.current.onForceMuted?.({ muted: true });
      });
    };

    socket.on('connect', () => {
      setConnected(true);
      announce();
      // Une reconnexion signifie qu'on a pu manquer des événements pendant la
      // coupure : on force une resynchronisation depuis la base.
      handlersRef.current.onDirty?.({ reason: 'reconnect' });
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('control:dirty', (payload) => handlersRef.current.onDirty?.(payload));
    socket.on('control:participant-updated', (payload) => handlersRef.current.onParticipantUpdated?.(payload));
    socket.on('control:meeting-updated', (payload) => handlersRef.current.onMeetingUpdated?.(payload));
    socket.on('control:ejected', (payload) => handlersRef.current.onEjected?.(payload));
    socket.on('force-muted', (payload) => handlersRef.current.onForceMuted?.(payload));

    // Rattrapage à l'arrivée ou après un rechargement de page.
    socket.on('control:transcript-state', ({ finals, partials }) => {
      publishTranscript({
        finals: (finals || []).map(withId),
        partials: (partials || []).map(withId),
      });
    });

    // Phrase confirmée : elle ne bougera plus.
    socket.on('control:transcript-final', ({ segment }) => {
      const { finals, partials } = transcriptRef.current;

      const next = [...finals];

      // Une phrase déjà affichée est REMPLACÉE sur place. C'est ce qui permet au
      // texte brut d'apparaître instantanément puis d'être corrigé par le LLM
      // quelques secondes plus tard, sans doublon ni saut à la lecture. On
      // conserve son identifiant de rendu pour que React ne remonte pas la ligne.
      const existing = segment.segmentId
        ? next.findIndex((item) => item.segmentId === segment.segmentId)
        : -1;

      if (existing >= 0) {
        next[existing] = { ...segment, id: next[existing].id };
      } else {
        // Insertion à sa place CHRONOLOGIQUE. Deux locuteurs dont les
        // transcriptions n'avancent pas au même rythme arrivent dans le
        // désordre, et une réponse s'afficherait alors avant sa question. On
        // remonte depuis la fin, le cas courant restant l'ajout en queue.
        let index = next.length;
        while (index > 0 && (next[index - 1].spokenAt ?? 0) > (segment.spokenAt ?? 0)) index -= 1;
        next.splice(index, 0, withId(segment));
      }

      publishTranscript({
        finals: next.slice(-TRANSCRIPT_LIMIT),
        // L'hypothèse de ce locuteur vient d'être tranchée : la garder
        // afficherait le même texte deux fois, en gris et en noir.
        partials: partials.filter((item) => item.participantId !== segment.participantId),
      });
    });

    // Hypothèse : affichée en gris, elle peut encore changer. Une seule par
    // locuteur, la plus récente.
    socket.on('control:transcript-partial', ({ segment }) => {
      const { finals, partials } = transcriptRef.current;
      const others = partials.filter((item) => item.participantId !== segment.participantId);
      publishTranscript({
        finals,
        partials: segment.text?.trim() ? [...others, withId(segment)] : others,
      });
    });

    return () => {
      socket.emit('control:leave');
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
    // publishTranscript et withId sont des useCallback à dépendances vides,
    // donc stables : les lister satisfait la règle sans rouvrir la connexion.
  }, [meetingId, publishTranscript, withId]);

  // Réannoncer son identité quand elle se précise (la ligne participant est
  // créée après l'ouverture de la connexion, et le nom d'un invité est saisi
  // encore plus tard).
  useEffect(() => {
    if (!meetingId || !socketRef.current?.connected) return;
    socketRef.current.emit('control:join', identityRef.current);
  }, [meetingId, participantId, userId, displayName, isHost]);

  const sendParticipantUpdate = useCallback((participantId, userId, patch) => {
    socketRef.current?.emit('control:participant-updated', {
      meetingId: identityRef.current.meetingId,
      participantId,
      userId,
      patch,
    });
  }, []);

  const sendMeetingUpdate = useCallback((patch) => {
    socketRef.current?.emit('control:meeting-updated', {
      meetingId: identityRef.current.meetingId,
      patch,
    });
  }, []);

  const sendChat = useCallback((message) => {
    socketRef.current?.emit('control:chat', {
      meetingId: identityRef.current.meetingId,
      message,
    });
  }, []);

  const sendReaction = useCallback((reaction) => {
    socketRef.current?.emit('control:chat-reaction', {
      meetingId: identityRef.current.meetingId,
      reaction,
    });
  }, []);

  // Permet à un composant enfant (le chat du panneau latéral) d'écouter le
  // canal sans qu'on ait à remonter son état jusqu'à la page.
  const subscribe = useCallback((event, handler) => {
    const socket = socketRef.current;
    if (!socket) return () => {};
    socket.on(event, handler);
    return () => socket.off(event, handler);
  }, []);

  // Objet mémoïsé : les consommateurs le mettent en dépendance d'effets
  // (le chat s'abonne au canal), et une nouvelle référence à chaque rendu les
  // ferait se désabonner/réabonner en boucle.
  return useMemo(
    () => ({
      connected,
      sendParticipantUpdate,
      sendMeetingUpdate,
      sendChat,
      sendReaction,
      subscribe,
      subscribeTranscript,
      getTranscript,
    }),
    [
      connected,
      sendParticipantUpdate,
      sendMeetingUpdate,
      sendChat,
      sendReaction,
      subscribe,
      subscribeTranscript,
      getTranscript,
    ]
  );
}
