'use client';

import { CalendarClock, FileText } from 'lucide-react';
import { formatShortDate, formatDuration, meetingDuration } from '@/lib/datetime';

const COLUMNS = 'grid-cols-[2.2fr_1fr_.9fr_.8fr_150px]';

export default function HistorySection({
  meetings, participantsByMeeting, timeZone, transcribedMeetings, onOpenTranscript,
}) {
  if (meetings.length === 0) {
    return (
      <div className="max-w-[1080px] bg-surface border border-slate-200 rounded-lg p-12 text-center">
        <CalendarClock className="h-9 w-9 text-slate-500 mx-auto mb-4" />
        <p className="text-[15px] font-medium text-slate-950">Aucune réunion passée</p>
        <p className="text-[13px] text-slate-700 mt-1.5">
          Vos réunions terminées apparaîtront ici, avec leur durée et leurs participants.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-[1080px]">
      <div className="bg-surface border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto scrollbar-hide">
          <div className="min-w-[760px]">
            <div className={`grid ${COLUMNS} gap-4 px-5 py-3.5 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold tracking-overline uppercase text-slate-500`}>
              <span>Réunion</span>
              <span>Date</span>
              <span>Durée</span>
              <span>Participants</span>
              <span>Transcription</span>
            </div>

            {meetings.map((meeting) => {
              const people = participantsByMeeting[meeting.id] || [];
              const duration = meetingDuration(people);

              return (
                <div
                  key={meeting.id}
                  className={`grid ${COLUMNS} gap-4 items-center px-5 py-4 border-b border-slate-100 last:border-b-0 text-[14px] hover:bg-slate-50 transition-colors`}
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{meeting.title}</p>
                    <p className="mt-0.5 font-mono text-[12px] text-slate-500">{meeting.meeting_code}</p>
                  </div>
                  <span className="text-slate-700">
                    {formatShortDate(meeting.scheduled_at || meeting.created_at, timeZone)}
                  </span>
                  <span className="font-mono text-slate-700">{formatDuration(duration)}</span>
                  <span className="text-slate-700">{people.length}</span>
                  <div className="flex justify-start">
                    {/* Le template propose ici « Voir le rapport » / « Rédaction IA… ».
                        Le RÉSUMÉ automatique n'existe toujours pas, mais la
                        transcription, elle, est désormais conservée : on ouvre le
                        texte réel plutôt qu'une promesse que rien ne tient.
                        Sans phrase enregistrée, l'état reste explicite au lieu
                        d'un bouton qui ne mènerait nulle part. */}
                    {transcribedMeetings?.has(meeting.id) ? (
                      <button
                        onClick={() => onOpenTranscript?.(meeting)}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-sm border border-slate-200 text-[13px] font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        Voir
                      </button>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-overline uppercase text-slate-500 bg-slate-100 rounded-xs px-2 py-1"
                        title="Aucune parole enregistrée pour cette réunion."
                      >
                        <FileText className="h-3 w-3" />
                        Aucune
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
