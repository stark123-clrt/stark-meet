'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, Copy, Check, Clock, Link2 } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { formatLongDate } from '@/lib/datetime';
import { formatTimeRange } from '@/lib/meetingSchedule';

/**
 * Écran de préparation, avant d'entrer dans la salle.
 *
 * Sert aussi d'écran d'attente : un invité en salle d'attente y voit son
 * aperçu et règle son micro pendant que l'hôte l'admet, au lieu de patienter
 * devant une page vide. Le bouton « Rejoindre » cède alors la place à l'état
 * d'attente.
 */
export default function Lobby({
  meeting,
  displayName,
  userId,
  localStream,
  isMicOn,
  isVideoOn,
  onToggleMic,
  onToggleVideo,
  onJoin,
  joining = false,
  waiting = false,
  invitedCount = 0,
  error = '',
  timeZone,
}) {
  const videoRef = useRef(null);
  const [copied, setCopied] = useState(false);

  // Le flux est branché dès qu'il existe ; l'aperçu est en miroir, comme dans
  // toutes les applications d'appel — on se voit comme dans une glace.
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !localStream) return;

    element.srcObject = localStream;
    element.play().catch(() => {});
    return () => { element.srcObject = null; };
  }, [localStream, isVideoOn]);

  const copyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/room/${meeting?.meeting_code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const controlClass = (active) =>
    `w-12 h-12 rounded-full flex items-center justify-center transition-colors duration-200 ease-standard ${
      active
        ? 'bg-white/15 text-white hover:bg-white/25'
        : 'bg-error-500 text-white hover:brightness-110'
    }`;

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-[1040px] grid lg:grid-cols-[1.35fr_1fr] gap-6 lg:gap-8 items-stretch">

        {/* ---- Aperçu caméra ---- */}
        <div className="relative bg-stage rounded-lg overflow-hidden min-h-[300px] lg:min-h-[460px]">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`absolute inset-0 w-full h-full object-cover scale-x-[-1] transition-opacity duration-300 ${
              isVideoOn && localStream ? 'opacity-100' : 'opacity-0'
            }`}
          />

          {(!isVideoOn || !localStream) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <Avatar size="lg" name={displayName} seed={userId} className="!w-20 !h-20 !text-2xl" />
              <p className="text-[13px] text-white/50">
                {localStream ? 'Caméra désactivée' : 'Préparation de la caméra…'}
              </p>
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />

          <p className="absolute left-4 bottom-5 text-[14px] font-medium text-white drop-shadow">
            {displayName}
          </p>

          <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-3">
            <button onClick={onToggleMic} title="Micro" className={controlClass(isMicOn)}>
              {isMicOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
            </button>
            <button onClick={onToggleVideo} title="Caméra" className={controlClass(isVideoOn)}>
              {isVideoOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* ---- Informations de la réunion ---- */}
        <div className="bg-surface border border-slate-200 rounded-lg p-7 flex flex-col">
          <div className="flex items-center gap-3">
            <Avatar size="md" name={displayName} seed={userId} />
            <div className="min-w-0">
              <p className="text-[14px] font-medium truncate">{displayName}</p>
              <p className="text-[12px] text-slate-500">Vous</p>
            </div>
          </div>

          <p className="mt-7 text-[11px] font-semibold tracking-overline uppercase text-slate-500">
            {meeting?.scheduled_at ? 'Réunion planifiée' : 'Réunion instantanée'}
          </p>
          <h1 className="mt-2 font-display font-bold text-[24px] leading-snug tracking-heading">
            {meeting?.title || 'Réunion'}
          </h1>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-slate-700">
            {meeting?.scheduled_at
              ? `${formatLongDate(meeting.scheduled_at, timeZone)} · ${formatTimeRange(meeting, timeZone)}`
              : 'Démarrage immédiat'}
            {invitedCount > 0 && ` · ${invitedCount} participant${invitedCount > 1 ? 's' : ''}`}
          </p>

          <button
            onClick={copyLink}
            className="mt-5 flex items-center gap-2.5 w-full px-3.5 h-11 rounded-sm border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
          >
            <Link2 className="h-4 w-4 text-slate-500 flex-none" />
            <span className="flex-1 min-w-0 font-mono text-[13px] text-slate-700 truncate">
              {meeting?.meeting_code}
            </span>
            {copied
              ? <Check className="h-4 w-4 text-success-500 flex-none" />
              : <Copy className="h-4 w-4 text-slate-500 flex-none" />}
          </button>

          {error && (
            <p className="mt-4 px-3.5 py-2.5 rounded-sm bg-warning-50 text-[13px] text-slate-700">
              {error}
            </p>
          )}

          <div className="mt-auto pt-7">
            {waiting ? (
              <div className="flex items-start gap-3 px-4 py-3.5 rounded-sm bg-brand-50">
                <Clock className="mt-0.5 h-4 w-4 text-brand-500 flex-none animate-pulse" />
                <div>
                  <p className="text-[14px] font-medium text-slate-950">En attente d&apos;admission</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-slate-700">
                    L&apos;hôte doit vous laisser entrer. Vous entrerez automatiquement, sans recharger
                    la page.
                  </p>
                </div>
              </div>
            ) : (
              <button
                onClick={onJoin}
                disabled={joining}
                className="w-full h-12 rounded-sm bg-brand-500 text-surface text-[15px] font-semibold hover:bg-brand-600 hover:shadow-brand-glow transition duration-200 ease-standard disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
              >
                {joining ? 'Connexion…' : 'Rejoindre maintenant'}
              </button>
            )}

            <p className="mt-3 text-[12px] text-center text-slate-500">
              Vos réglages micro et caméra sont conservés en entrant.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
