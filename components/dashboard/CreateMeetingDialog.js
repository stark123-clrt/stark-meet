'use client';

import { useState } from 'react';
import { X, Video, Calendar } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { generateMeetingCode } from '@/lib/meetingCode';
import Switch from '@/components/ui/Switch';

export default function CreateMeetingDialog({ hostId, defaultWaitingRoom = true, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [waitingRoomEnabled, setWaitingRoomEnabled] = useState(defaultWaitingRoom);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createClient();
      const { data, error: insertError } = await supabase
        .from('meetings')
        .insert({
          host_id: hostId,
          title: title.trim() || 'Réunion sans titre',
          meeting_code: generateMeetingCode(),
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
    <div className="fixed inset-0 bg-slate-950/40 flex items-center justify-center p-4 z-50">
      <div className="bg-surface rounded-lg shadow-overlay max-w-md w-full border border-slate-200">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200">
          <h3 className="font-display font-bold text-[17px] tracking-heading">Nouvelle réunion</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-sm text-slate-500 hover:text-slate-950 hover:bg-slate-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
          {error && (
            <p className="px-3.5 py-2.5 rounded-sm bg-error-50 text-error-500 text-[13px]">{error}</p>
          )}

          <label className="block">
            <span className="block text-[13px] font-medium text-slate-700 mb-1.5">Titre</span>
            <div className="relative">
              <Video className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Point d'équipe hebdo"
                className="w-full h-11 pl-10 pr-3.5 rounded-sm border border-slate-200 bg-surface text-[15px] placeholder:text-slate-500 outline-none transition-shadow duration-200 focus:border-brand-500 focus:shadow-focus"
              />
            </div>
          </label>

          <label className="block">
            <span className="block text-[13px] font-medium text-slate-700 mb-1.5">
              Date et heure <span className="text-slate-500 font-normal">— vide pour démarrer maintenant</span>
            </span>
            <div className="relative">
              <Calendar className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full h-11 pl-10 pr-3.5 rounded-sm border border-slate-200 bg-surface text-[15px] outline-none transition-shadow duration-200 focus:border-brand-500 focus:shadow-focus"
              />
            </div>
          </label>

          <div className="flex items-center gap-4 py-1">
            <div className="flex-1">
              <p className="text-[14px] font-medium">Salle d&apos;attente</p>
              <p className="mt-0.5 text-[13px] text-slate-700">
                Vous admettez chaque participant avant qu&apos;il entre.
              </p>
            </div>
            <Switch
              label="Salle d'attente"
              checked={waitingRoomEnabled}
              onChange={setWaitingRoomEnabled}
            />
          </div>

          <p className="text-[12px] text-slate-500">Le lien est généré dès la création.</p>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-11 rounded-sm border border-slate-200 text-[15px] font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 h-11 rounded-sm bg-brand-500 text-surface text-[15px] font-semibold hover:bg-brand-600 transition-colors disabled:opacity-50"
            >
              {loading ? 'Création…' : 'Créer la réunion'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
