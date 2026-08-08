'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Mic, MicOff, UserX, Send } from 'lucide-react';
import { createClient } from '@/lib/supabase';

/**
 * SidePanel — panneau latéral à onglets Discussion / Participants, fidèle
 * au template Claude Design : colonne fixe de 328px toujours visible sur
 * grand écran, superposition plein écran fermable sur mobile.
 */
export default function SidePanel({
  meetingId,
  currentUserId,
  currentUserName,
  isHost,
  roomChannel,
  participants,
  waitingParticipants,
  onAdmit,
  onDeny,
  onForceMute,
  onRemove,
  mobileOpen,
  onCloseMobile,
}) {
  const [tab, setTab] = useState('participants');
  const admitted = participants || [];
  const waiting = waitingParticipants || [];
  const totalCount = admitted.length + waiting.length;

  const [processingIds, setProcessingIds] = useState(new Set());
  const runAction = async (id, action) => {
    setProcessingIds((prev) => new Set(prev).add(id));
    try {
      await action?.(id);
    } catch (err) {
      console.error('Erreur action participant:', err);
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={onCloseMobile} />
      )}

      <div
        className={`flex-none w-full sm:w-[328px] bg-ink-900 border-l border-ink-700 flex-col min-h-0 fixed inset-y-0 right-0 z-40 lg:static lg:z-auto ${
          mobileOpen ? 'flex' : 'hidden lg:flex'
        }`}
      >
        <div className="flex flex-none items-center border-b border-ink-700">
          <button
            onClick={() => setTab('discussion')}
            className={`flex-1 text-center py-3.5 text-[13.5px] font-mono transition-colors ${
              tab === 'discussion' ? 'text-white bg-ink-800 border-b-2 border-signal-500' : 'text-ink-500'
            }`}
          >
            Discussion
          </button>
          <button
            onClick={() => setTab('participants')}
            className={`flex-1 text-center py-3.5 text-[13.5px] font-mono transition-colors ${
              tab === 'participants' ? 'text-white bg-ink-800 border-b-2 border-signal-500' : 'text-ink-500'
            }`}
          >
            Participants · {totalCount}
          </button>
          <button onClick={onCloseMobile} className="lg:hidden p-3 text-ink-500 hover:text-white flex-none">
            <X className="h-4 w-4" />
          </button>
        </div>

        {tab === 'participants' ? (
          <ParticipantsTab
            waiting={waiting}
            admitted={admitted}
            isHost={isHost}
            onAdmit={onAdmit}
            onDeny={onDeny}
            onForceMute={onForceMute}
            onRemove={onRemove}
            processingIds={processingIds}
            runAction={runAction}
          />
        ) : (
          <DiscussionTab
            meetingId={meetingId}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            roomChannel={roomChannel}
          />
        )}
      </div>
    </>
  );
}

function initialsOf(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

function ParticipantsTab({ waiting, admitted, isHost, onAdmit, onDeny, onForceMute, onRemove, processingIds, runAction }) {
  return (
    <div className="flex-1 overflow-y-auto scrollbar-hide p-4 flex flex-col gap-5 min-h-0">
      {isHost && waiting.length > 0 && (
        <div className="flex flex-col gap-3 border border-amber-500/30 bg-amber-500/5 rounded-md p-3.5">
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold tracking-wide text-amber-500">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
            SALLE D'ATTENTE · {waiting.length}
          </span>
          <div className="flex flex-col gap-2.5">
            {waiting.map((w) => (
              <div key={w.id} className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-full bg-white/[0.09] text-white font-mono text-[11px] font-semibold flex items-center justify-center flex-none">
                  {initialsOf(w.display_name)}
                </span>
                <span className="flex-1 text-[13.5px] font-medium text-white truncate min-w-0">{w.display_name}</span>
                <button
                  onClick={() => runAction(w.id, onAdmit)}
                  disabled={processingIds.has(w.id)}
                  className="text-xs font-semibold px-2.5 py-1.5 rounded bg-ok-500 text-ink-950 hover:brightness-110 transition disabled:opacity-50 flex-none"
                >
                  {processingIds.has(w.id) ? '…' : 'Admettre'}
                </button>
                <button
                  onClick={() => runAction(w.id, onDeny)}
                  disabled={processingIds.has(w.id)}
                  className="w-7 h-7 rounded bg-white/[0.07] text-ink-500 hover:text-white transition disabled:opacity-50 flex-none flex items-center justify-center"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10.5px] font-bold tracking-wide text-ink-600 pb-2">
          DANS LA RÉUNION · {admitted.length}
        </span>
        {admitted.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 py-2 px-1.5 rounded-md hover:bg-white/[0.04] transition-colors group">
            <span className="w-8 h-8 rounded-full bg-white/[0.09] text-white font-mono text-[11px] font-semibold flex items-center justify-center flex-none">
              {initialsOf(p.display_name)}
            </span>
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <span className="text-[13.5px] font-medium text-white truncate">{p.display_name}</span>
              {(p.role === 'host' || p.role === 'co-host') && (
                <span className="font-mono text-[9px] font-bold tracking-wide text-ok-500 border border-ok-500/35 rounded px-1.5 py-0.5 flex-none">
                  {p.role === 'host' ? 'HÔTE' : 'CO-HÔTE'}
                </span>
              )}
            </div>
            <span className={p.force_muted ? 'text-danger-500' : 'text-ink-500'}>
              {p.force_muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            </span>
            {isHost && p.role !== 'host' && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-none">
                <button
                  onClick={() => onForceMute?.(p.id)}
                  className="w-[26px] h-[26px] rounded text-ink-500 hover:text-white hover:bg-white/[0.08] flex items-center justify-center"
                  title={p.force_muted ? 'Réautoriser le micro' : 'Couper le micro'}
                >
                  {p.force_muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => onRemove?.(p.id)}
                  className="w-[26px] h-[26px] rounded text-ink-500 hover:text-danger-500 hover:bg-white/[0.08] flex items-center justify-center"
                  title="Exclure de la réunion"
                >
                  <UserX className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiscussionTab({ meetingId, currentUserId, currentUserName, roomChannel }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  // Historique : lu une fois depuis Supabase à l'ouverture.
  useEffect(() => {
    if (!meetingId) return;
    const supabase = createClient();

    supabase
      .from('meeting_messages')
      .select('*')
      .eq('meeting_id', meetingId)
      .order('created_at', { ascending: true })
      .then(({ data }) => setMessages(data || []));
  }, [meetingId]);

  // Messages en direct : relayés par le serveur Socket.io. Le dédoublonnage
  // par id couvre le cas où un message arriverait par deux chemins.
  useEffect(() => {
    if (!roomChannel?.connected) return;
    return roomChannel.subscribe('control:chat', ({ message }) => {
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    });
  }, [roomChannel, roomChannel?.connected]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setDraft('');

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

    if (error) {
      console.error('Erreur envoi message:', error);
      setDraft(content);
    } else if (data) {
      setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data]));
      roomChannel?.sendChat(data);
    }

    setSending(false);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hide p-4 flex flex-col gap-4">
        {messages.length === 0 && (
          <p className="text-ink-500 text-sm text-center mt-8">Aucun message pour l'instant.</p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold text-white">
                {msg.sender_id === currentUserId ? 'Vous' : msg.sender_name}
              </span>
              <span className="font-mono text-[11px] text-ink-600">
                {new Date(msg.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <span className="text-[13.5px] leading-relaxed text-mist-300">{msg.content}</span>
          </div>
        ))}
      </div>
      <form onSubmit={handleSend} className="flex-none p-3.5 border-t border-ink-700 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Écrire un message…"
          className="flex-1 bg-white/[0.05] border border-ink-700 rounded-md px-3.5 py-2.5 text-[13.5px] text-white placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="p-2.5 rounded-md bg-signal-500 hover:bg-signal-400 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex-none"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
