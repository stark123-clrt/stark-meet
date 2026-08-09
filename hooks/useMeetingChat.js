/**
 * useMeetingChat — état du chat d'une réunion.
 *
 * Ce hook est appelé par SidePanel, et non par l'onglet Discussion lui-même :
 * les onglets sont montés/démontés par un ternaire, si bien qu'un chat vivant
 * dans l'onglet cessait d'exister dès qu'on regardait la liste des
 * participants (abonnement socket coupé, état perdu, compteur de non-lus
 * impossible). SidePanel, lui, reste monté en permanence — il est seulement
 * masqué en CSS sur mobile.
 *
 * Répartition habituelle du projet : Supabase persiste, Socket.io diffuse.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';

export default function useMeetingChat({ meetingId, currentUserId, currentUserName, roomChannel, isVisible }) {
  const [messages, setMessages] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Lu par les handlers socket, qui sont enregistrés une seule fois : passer
  // par une ref évite de les réenregistrer à chaque changement d'onglet.
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const upsertMessage = useCallback((message) => {
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
  }, []);

  // ---- Historique ----
  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;

    const load = async () => {
      const supabase = createClient();
      // Les réactions arrivent dans la même requête via l'imbrication
      // PostgREST (relation détectée par la clé étrangère message_id).
      const { data, error } = await supabase
        .from('meeting_messages')
        .select('*, reactions:meeting_message_reactions(*)')
        .eq('meeting_id', meetingId)
        .order('created_at', { ascending: true });

      if (cancelled) return;
      if (error) console.error('Erreur chargement des messages:', error);
      setMessages(data || []);
      setLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [meetingId]);

  // ---- Temps réel ----
  useEffect(() => {
    if (!roomChannel?.connected) return;

    const offChat = roomChannel.subscribe('control:chat', ({ message }) => {
      upsertMessage(message);
      if (!isVisibleRef.current) setUnreadCount((n) => n + 1);
    });

    const offReaction = roomChannel.subscribe('control:chat-reaction', ({ reaction }) => {
      applyReaction(setMessages, reaction);
    });

    return () => {
      offChat();
      offReaction();
    };
  }, [roomChannel, upsertMessage]);

  // Ouvrir la discussion vaut lecture.
  useEffect(() => {
    if (isVisible) setUnreadCount(0);
  }, [isVisible, messages.length]);

  const markRead = useCallback(() => setUnreadCount(0), []);

  // ---- Envoi ----
  const sendMessage = useCallback(async (rawContent) => {
    const content = rawContent.trim();
    if (!content || !meetingId) return { ok: false };

    const supabase = createClient();
    const { data, error } = await supabase
      .from('meeting_messages')
      .insert({
        meeting_id: meetingId,
        sender_id: currentUserId,
        sender_name: currentUserName,
        content,
      })
      .select()
      .single();

    if (error || !data) {
      console.error('Erreur envoi message:', error);
      return { ok: false };
    }

    const message = { ...data, reactions: [] };
    upsertMessage(message);
    roomChannel?.sendChat(message);
    return { ok: true };
  }, [meetingId, currentUserId, currentUserName, roomChannel, upsertMessage]);

  // ---- Réactions ----
  const toggleReaction = useCallback(async (messageId, emoji) => {
    const message = messages.find((m) => m.id === messageId);
    const mine = message?.reactions?.find((r) => r.user_id === currentUserId && r.emoji === emoji);
    const supabase = createClient();

    if (mine) {
      // Retrait : on met à jour l'affichage tout de suite, la base ensuite.
      const reaction = { message_id: messageId, user_id: currentUserId, emoji, removed: true };
      applyReaction(setMessages, reaction);
      roomChannel?.sendReaction(reaction);

      const { error } = await supabase
        .from('meeting_message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', currentUserId)
        .eq('emoji', emoji);

      if (error) console.error('Erreur retrait de réaction:', error);
      return;
    }

    const { data, error } = await supabase
      .from('meeting_message_reactions')
      .insert({
        message_id: messageId,
        user_id: currentUserId,
        user_name: currentUserName,
        emoji,
      })
      .select()
      .single();

    if (error || !data) {
      console.error('Erreur ajout de réaction:', error);
      return;
    }

    applyReaction(setMessages, data);
    roomChannel?.sendReaction(data);
  }, [messages, currentUserId, currentUserName, roomChannel]);

  return useMemo(
    () => ({ messages, loading, unreadCount, markRead, sendMessage, toggleReaction }),
    [messages, loading, unreadCount, markRead, sendMessage, toggleReaction]
  );
}

/**
 * Applique l'ajout ou le retrait d'une réaction à la liste des messages.
 * `removed: true` distingue un retrait d'un ajout — les deux transitent par le
 * même événement socket.
 */
function applyReaction(setMessages, reaction) {
  const { message_id, user_id, emoji, removed } = reaction;

  setMessages((prev) =>
    prev.map((message) => {
      if (message.id !== message_id) return message;

      const others = (message.reactions || []).filter(
        (r) => !(r.user_id === user_id && r.emoji === emoji)
      );

      return { ...message, reactions: removed ? others : [...others, reaction] };
    })
  );
}
