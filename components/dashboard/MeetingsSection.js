'use client';

import { useState } from 'react';
import { Video, CalendarDays, Link2, Copy, Check, Trash2 } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { formatDayBadge, formatTime } from '@/lib/datetime';
import { parseMeetingCode } from '@/lib/meetingCode';

function ActionCard({ icon: Icon, title, text, onClick, tone = 'brand', children }) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      onClick={onClick}
      className={`flex flex-col items-start gap-3 p-5 bg-surface border border-slate-200 rounded-lg text-left transition duration-200 ease-standard ${
        onClick ? 'hover:-translate-y-0.5 hover:shadow-card-hover' : ''
      }`}
    >
      <span
        className={`w-[38px] h-[38px] rounded-md flex items-center justify-center ${
          tone === 'brand' ? 'bg-brand-500 text-surface' : 'bg-brand-50 text-brand-500'
        }`}
      >
        <Icon className="h-[19px] w-[19px]" />
      </span>
      <span className="font-display font-bold text-[16px] tracking-heading">{title}</span>
      {text && <span className="text-[13px] leading-relaxed text-slate-700">{text}</span>}
      {children}
    </Wrapper>
  );
}

export default function MeetingsSection({
  meetings,
  participantsByMeeting,
  timeZone,
  onInstant,
  onSchedule,
  onJoinCode,
  onCopyLink,
  copiedCode,
  onOpen,
  onDelete,
  creatingInstant,
}) {
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');

  const submitCode = (event) => {
    event?.preventDefault();
    const parsed = parseMeetingCode(code);
    if (!parsed) {
      setCodeError('Code invalide');
      return;
    }
    onJoinCode(parsed);
  };

  return (
    <div className="max-w-[1080px] flex flex-col gap-8">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        <ActionCard
          icon={Video}
          title="Réunion instantanée"
          text={creatingInstant ? 'Création du lien…' : 'Créez un lien et démarrez l\'appel tout de suite.'}
          onClick={creatingInstant ? undefined : onInstant}
        />
        <ActionCard
          icon={CalendarDays}
          title="Planifier"
          text="Choisissez une date, invitez et envoyez le lien."
          tone="wash"
          onClick={onSchedule}
        />
        <ActionCard icon={Link2} title="Rejoindre" tone="wash">
          <form onSubmit={submitCode} className="flex gap-2 w-full">
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value); setCodeError(''); }}
              placeholder="Code de réunion"
              aria-label="Code de réunion"
              className={`flex-1 min-w-0 h-10 px-3 rounded-sm border bg-surface text-[14px] placeholder:text-slate-500 outline-none transition-shadow focus:shadow-focus ${
                codeError ? 'border-error-500' : 'border-slate-200 focus:border-brand-500'
              }`}
            />
            <button
              type="submit"
              className="h-10 px-4 flex-none rounded-sm border border-slate-200 bg-surface text-[14px] font-semibold hover:bg-slate-100 transition-colors"
            >
              Entrer
            </button>
          </form>
        </ActionCard>
      </div>

      <div>
        <div className="flex items-baseline gap-3 mb-4">
          <h2 className="font-display font-bold text-[18px] tracking-heading">À venir</h2>
          <p className="text-[13px] text-slate-500">
            {meetings.length === 0 ? 'aucune' : `${meetings.length} réunion${meetings.length > 1 ? 's' : ''}`}
          </p>
        </div>

        {meetings.length === 0 ? (
          <div className="bg-surface border border-slate-200 rounded-lg p-12 text-center">
            <Video className="h-9 w-9 text-slate-500 mx-auto mb-4" />
            <p className="text-[15px] font-medium text-slate-950">Aucune réunion à venir</p>
            <p className="text-[13px] text-slate-700 mt-1.5">
              Lancez une réunion instantanée ou planifiez-en une.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {meetings.map((meeting) => {
              const badge = formatDayBadge(meeting.scheduled_at || meeting.created_at, timeZone);
              const people = participantsByMeeting[meeting.id] || [];
              const isLive = meeting.status === 'active';

              return (
                <div
                  key={meeting.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5 p-[18px] sm:px-5 bg-surface border border-slate-200 rounded-lg transition-shadow duration-200 ease-standard hover:shadow-card-hover"
                >
                  <div className="flex items-center gap-5">
                    <div className="flex-none w-16 text-center">
                      <p className="text-[11px] font-semibold tracking-overline uppercase text-slate-500">
                        {badge.month}
                      </p>
                      <p className="font-display font-bold text-[26px] tracking-heading">{badge.day}</p>
                    </div>
                    <span className="hidden sm:block flex-none w-px h-11 bg-slate-200" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-[15px] font-medium truncate">{meeting.title}</h3>
                      {isLive && (
                        <span className="flex-none flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-overline uppercase text-success-500 bg-success-50 rounded-xs px-2 py-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-success-500" />
                          En cours
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] text-slate-700">
                      {meeting.scheduled_at ? formatTime(meeting.scheduled_at, timeZone) : 'Instantanée'}
                      {' · '}
                      {people.length} participant{people.length > 1 ? 's' : ''}
                      {' · '}
                      <span className="font-mono">{meeting.meeting_code}</span>
                    </p>
                  </div>

                  {people.length > 0 && (
                    <div className="flex-none flex">
                      {people.slice(0, 3).map((person) => (
                        <Avatar
                          key={person.id}
                          size="sm"
                          ring
                          className="-mr-2"
                          name={person.display_name}
                          seed={person.profile_id || person.guest_id || person.id}
                        />
                      ))}
                      {people.length > 3 && (
                        <span className="-mr-2 w-8 h-8 rounded-full border-2 border-surface bg-slate-100 text-slate-700 font-mono text-[10px] font-bold flex items-center justify-center">
                          +{people.length - 3}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex-none flex items-center gap-2 sm:ml-3">
                    <button
                      onClick={() => onCopyLink(meeting.meeting_code)}
                      className="h-8 px-3 flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors"
                    >
                      {copiedCode === meeting.meeting_code
                        ? <><Check className="h-3.5 w-3.5 text-success-500" /> Copié</>
                        : <><Copy className="h-3.5 w-3.5" /> Lien</>}
                    </button>
                    <button
                      onClick={() => onOpen(meeting.meeting_code)}
                      className="h-8 px-4 flex-none rounded-sm bg-brand-500 text-surface text-[13px] font-semibold hover:bg-brand-600 transition-colors"
                    >
                      Rejoindre
                    </button>
                    <button
                      onClick={() => onDelete(meeting)}
                      title="Supprimer la réunion"
                      className="w-8 h-8 flex-none flex items-center justify-center rounded-sm text-slate-500 hover:text-error-500 hover:bg-slate-100 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
