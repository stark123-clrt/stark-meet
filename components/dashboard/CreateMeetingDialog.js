'use client';

import { useState } from 'react';
import { X, Video, Calendar } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { generateMeetingCode } from '@/lib/meetingCode';

export default function CreateMeetingDialog({ hostId, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [waitingRoomEnabled, setWaitingRoomEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createClient();
      const meetingCode = generateMeetingCode();

      const { data, error: insertError } = await supabase
        .from('meetings')
        .insert({
          host_id: hostId,
          title: title.trim() || 'Réunion sans titre',
          meeting_code: meetingCode,
          scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          waiting_room_enabled: waitingRoomEnabled,
          status: scheduledAt ? 'scheduled' : 'active',
        })
        .select()
        .single();

      if (insertError) throw insertError;

      onCreated?.(data);
    } catch (err) {
      setError(err.message || 'Une erreur est survenue');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-ink-900 rounded-lg shadow-2xl max-w-md w-full border border-ink-700">
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-700">
          <h3 className="text-white font-semibold text-base">Nouvelle réunion</h3>
          <button onClick={onClose} className="p-1.5 text-ink-500 hover:text-white hover:bg-ink-800 rounded-md transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="bg-signal-500/10 border border-signal-500/20 text-signal-300 px-3.5 py-2.5 rounded-md text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-mist-300 mb-1.5">Titre</label>
            <div className="relative">
              <Video className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500" />
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Point d'équipe hebdo"
                className="w-full pl-9 pr-3.5 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm placeholder:text-ink-500 focus:outline-none focus:border-signal-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-mist-300 mb-1.5">
              Date et heure <span className="text-ink-500">(laisser vide pour démarrer maintenant)</span>
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500" />
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full pl-9 pr-3.5 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm focus:outline-none focus:border-signal-500 transition-colors"
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer py-1">
            <input
              type="checkbox"
              checked={waitingRoomEnabled}
              onChange={(e) => setWaitingRoomEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-ink-600 bg-ink-800 text-signal-500 focus:ring-signal-500"
            />
            <span className="text-sm text-mist-300">Activer la salle d'attente</span>
          </label>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-ink-700 text-mist-300 hover:text-white hover:bg-ink-800 rounded-md text-sm font-medium transition-colors"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2.5 bg-signal-500 hover:bg-signal-400 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors"
            >
              {loading ? 'Création…' : 'Créer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
