'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Copy, Check, Download, FileText } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { formatLongDate } from '@/lib/datetime';

/**
 * Relecture de la transcription d'une réunion passée.
 *
 * Les phrases sont lues depuis `meeting_transcript_segments`, écrites par le
 * SFU pendant la réunion. Seules les phrases DÉFINITIVES y descendent : les
 * hypothèses grises n'existent que dans le direct.
 *
 * ⚠️ La politique RLS n'autorise que l'hôte et les participants identifiés. Un
 * jeu vide n'est donc pas forcément une réunion sans parole — cela peut aussi
 * être une réunion tenue avant la mise en service de la persistance. Le message
 * d'état le dit plutôt que de laisser croire à une panne.
 */

/** Regroupe les phrases consécutives d'un même locuteur en un seul bloc. */
function groupTurns(segments) {
  const turns = [];
  for (const segment of segments) {
    const last = turns[turns.length - 1];
    // Le nom est la bonne clé, pas l'identifiant : un invité qui recharge sa
    // page obtient un nouveau participantId et couperait son propre tour en
    // deux alors qu'il n'a pas cessé de parler.
    if (last && last.displayName === segment.display_name) {
      last.texts.push(segment.text);
    } else {
      turns.push({
        id: segment.id,
        displayName: segment.display_name,
        spokenAt: segment.spoken_at,
        texts: [segment.text],
      });
    }
  }
  return turns;
}

export default function TranscriptDialog({ meeting, timeZone, onClose }) {
  const [segments, setSegments] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const supabase = createClient();
      const { data, error: loadError } = await supabase
        .from('meeting_transcript_segments')
        .select('id, display_name, text, spoken_at')
        .eq('meeting_id', meeting.id)
        // Instant de PRONONCIATION : l'ordre d'écriture ne convient pas, deux
        // locuteurs dont les flux n'avancent pas au même rythme verraient une
        // réponse s'afficher avant sa question.
        .order('spoken_at', { ascending: true });

      if (cancelled) return;
      if (loadError) setError(loadError.message);
      else setSegments(data || []);
    };

    load();
    return () => { cancelled = true; };
  }, [meeting.id]);

  const turns = useMemo(() => groupTurns(segments || []), [segments]);

  const plainText = useMemo(
    () => turns.map((turn) => `${turn.displayName} : ${turn.texts.join(' ')}`).join('\n\n'),
    [turns]
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copie impossible — le navigateur l'a refusée.");
    }
  };

  const handleDownload = () => {
    const header = `${meeting.title}\n${meeting.meeting_code}\n\n`;
    const blob = new Blob([header + plainText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transcription-${meeting.meeting_code}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 bg-slate-950/40 flex items-center justify-center p-4 z-50">
      <div className="bg-surface rounded-lg shadow-overlay max-w-2xl w-full max-h-[85vh] flex flex-col border border-slate-200">
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-slate-200">
          <div className="min-w-0">
            <h3 className="font-display font-bold text-[17px] tracking-heading truncate">
              {meeting.title}
            </h3>
            <p className="mt-0.5 text-[13px] text-slate-700">
              {formatLongDate(meeting.scheduled_at || meeting.created_at, timeZone)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="shrink-0 p-1.5 rounded-sm text-slate-500 hover:text-slate-950 hover:bg-slate-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <p className="px-3.5 py-2.5 rounded-sm bg-error-50 text-error-500 text-[13px]">{error}</p>
          )}

          {!error && segments === null && (
            <p className="text-[14px] text-slate-700">Chargement…</p>
          )}

          {!error && segments !== null && turns.length === 0 && (
            <div className="py-10 text-center">
              <FileText className="h-9 w-9 text-slate-500 mx-auto mb-4" />
              <p className="text-[15px] font-medium text-slate-950">Aucune transcription</p>
              <p className="text-[13px] text-slate-700 mt-1.5 max-w-sm mx-auto">
                Personne n&apos;a parlé, ou cette réunion s&apos;est tenue avant
                que l&apos;enregistrement du texte ne soit activé.
              </p>
            </div>
          )}

          {turns.length > 0 && (
            <div className="flex flex-col gap-5">
              {turns.map((turn) => (
                <div key={turn.id}>
                  <p className="text-[11px] font-semibold tracking-overline uppercase text-slate-500">
                    {turn.displayName}
                  </p>
                  <p className="mt-1 text-[14px] leading-relaxed text-slate-950">
                    {turn.texts.join(' ')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {turns.length > 0 && (
          <div className="flex items-center gap-3 px-6 py-4 border-t border-slate-200">
            <span className="flex-1 text-[12px] text-slate-500">
              {turns.length} prise{turns.length > 1 ? 's' : ''} de parole
            </span>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-sm border border-slate-200 text-[13px] font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copié' : 'Copier'}
            </button>
            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-sm bg-brand-500 text-surface text-[13px] font-semibold hover:bg-brand-600 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Télécharger
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
