'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Send } from 'lucide-react';
import { createClient } from '@/lib/supabase';

export default function ChatPanel({ meetingId, currentUserId, currentUserName, isOpen, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!meetingId) return;

    const supabase = createClient();

    const loadMessages = async () => {
      const { data } = await supabase
        .from('meeting_messages')
        .select('*')
        .eq('meeting_id', meetingId)
        .order('created_at', { ascending: true });

      setMessages(data || []);
    };

    loadMessages();

    const channel = supabase
      .channel(`meeting-chat-${meetingId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'meeting_messages', filter: `meeting_id=eq.${meetingId}` },
        (payload) => setMessages(prev => [...prev, payload.new])
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [meetingId]);

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
    await supabase.from('meeting_messages').insert({
      meeting_id: meetingId,
      sender_id: currentUserId,
      sender_name: currentUserName,
      content,
    });

    setSending(false);
  };

  if (!isOpen) return null;

  return (
    <div className="flex flex-col w-80 h-full bg-ink-900 border-l border-ink-700 flex-shrink-0">
      <div className="flex items-center justify-between p-4 border-b border-ink-700">
        <h3 className="text-white font-semibold text-sm">Discussion</h3>
        <button onClick={onClose} className="p-1.5 text-ink-500 hover:text-white hover:bg-ink-800 rounded-md transition-colors">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hide p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-ink-500 text-sm text-center mt-8">Aucun message pour l'instant.</p>
        )}
        {messages.map((msg) => {
          const isMine = msg.sender_id === currentUserId;
          return (
            <div key={msg.id} className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
              <span className="text-[11px] font-mono text-ink-500 mb-1">
                {isMine ? 'Vous' : msg.sender_name}
              </span>
              <div
                className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
                  isMine ? 'bg-signal-500 text-white' : 'bg-ink-800 text-mist-100'
                }`}
              >
                {msg.content}
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={handleSend} className="p-3 border-t border-ink-700 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Écrire un message…"
          className="flex-1 bg-ink-800 border border-ink-700 rounded-md px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="p-2 rounded-md bg-signal-500 hover:bg-signal-400 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
