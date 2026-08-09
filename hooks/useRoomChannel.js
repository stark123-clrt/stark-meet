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

    return () => {
      socket.emit('control:leave');
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [meetingId]);

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
    () => ({ connected, sendParticipantUpdate, sendMeetingUpdate, sendChat, sendReaction, subscribe }),
    [connected, sendParticipantUpdate, sendMeetingUpdate, sendChat, sendReaction, subscribe]
  );
}
