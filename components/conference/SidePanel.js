'use client';

import { useEffect, useState } from 'react';
import {
  X, Mic, MicOff, Video, VideoOff, UserX, Hand, UserPlus, ChevronDown,
} from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import useMeetingChat from '@/hooks/useMeetingChat';
import ChatPanel from './ChatPanel';

/**
 * Vrai quand le panneau est affiché en colonne fixe (point de rupture `lg`),
 * plutôt qu'en feuille mobile. Mesuré dans un effet et non pendant le rendu,
 * pour ne pas diverger du rendu serveur.
 */
function useIsWidePanel() {
  const [isWide, setIsWide] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsWide(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return isWide;
}

function SectionHeader({ title, count, open, onToggle, action }) {
  return (
    <div className="flex-none flex items-center gap-2 px-4 h-[52px] border-b border-slate-200">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 min-w-0 text-left"
        aria-expanded={open}
      >
        <h2 className="font-display font-bold text-[16px] tracking-heading truncate">{title}</h2>
        {typeof count === 'number' && (
          <span className="text-[13px] text-slate-500 flex-none">· {count}</span>
        )}
        <ChevronDown
          className={`h-4 w-4 flex-none text-slate-500 transition-transform duration-200 ${
            open ? '' : '-rotate-90'
          }`}
        />
      </button>
      {action && <div className="ml-auto flex-none">{action}</div>}
    </div>
  );
}

/**
 * Panneau latéral : Participants et Discussion **empilés**, tous deux visibles
 * en même temps comme dans le template — et non en onglets, qui obligeaient à
 * choisir entre voir la salle et suivre la conversation.
 *
 * Chaque section se replie : sur la feuille mobile, la hauteur ne suffit pas
 * pour afficher les deux confortablement.
 */
export default function SidePanel({
  meetingId,
  currentUserId,
  currentUserName,
  isHost,
  roomChannel,
  participants,
  waitingParticipants,
  raisedHands,
  participantMedia,
  onAdmit,
  onDeny,
  onForceMute,
  onRemove,
  mobileOpen,
  onCloseMobile,
  onUnreadChange,
  onCopyInvite,
}) {
  const admitted = participants || [];
  const waiting = waitingParticipants || [];

  const isWidePanel = useIsWidePanel();
  const [participantsOpen, setParticipantsOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);

  // Sur mobile, la liste démarre repliée pour laisser la place à la discussion ;
  // sur grand écran les deux tiennent sans se gêner.
  useEffect(() => {
    setParticipantsOpen(isWidePanel);
  }, [isWidePanel]);

  // Le chat est piloté ici : les sections sont montées en permanence, donc son
  // abonnement socket ne se coupe plus quand on regarde les participants —
  // c'était le cas avec les onglets, qui démontaient l'un pour afficher l'autre.
  //
  // Il compte comme lu dès que le panneau est à l'écran et la section ouverte.
  const chatVisible = chatOpen && (isWidePanel || mobileOpen);

  const chat = useMeetingChat({
    meetingId,
    currentUserId,
    currentUserName,
    roomChannel,
    isVisible: chatVisible,
  });

  // Remonter le compteur dans un effet, jamais pendant le rendu : appeler le
  // parent en plein rendu déclencherait un setState croisé.
  useEffect(() => {
    onUnreadChange?.(chat.unreadCount);
  }, [chat.unreadCount, onUnreadChange]);

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
        <div className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={onCloseMobile} />
      )}

      {/* Sur mobile : feuille ancrée en bas, la réunion restant visible
          au-dessus — comme Zoom et Teams. Sur grand écran : colonne de 344 px. */}
      <div
        className={`bg-surface border-t lg:border-t-0 lg:border-l border-slate-200 flex-col min-h-0
          fixed inset-x-0 bottom-0 h-[78vh] rounded-t-2xl z-40 shadow-overlay
          lg:static lg:z-auto lg:flex-none lg:inset-auto lg:h-auto lg:w-[344px] lg:rounded-none lg:shadow-none ${
            mobileOpen ? 'flex' : 'hidden lg:flex'
          }`}
      >
        <div className="lg:hidden flex-none flex items-center justify-between pt-2 pb-1 px-3">
          <span className="w-9 h-1 rounded-full bg-slate-300 mx-auto" />
          <button onClick={onCloseMobile} className="p-1 text-slate-500 hover:text-slate-950">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ---- Participants ---- */}
        <SectionHeader
          title="Participants"
          count={admitted.length + waiting.length}
          open={participantsOpen}
          onToggle={() => setParticipantsOpen((v) => !v)}
          action={
            <button
              onClick={onCopyInvite}
              title="Copier le lien d'invitation"
              className="h-8 px-3 flex items-center gap-1.5 rounded-sm border border-slate-200 bg-surface text-[13px] font-medium text-slate-950 hover:bg-slate-100 transition-colors"
            >
              Ajouter
              <UserPlus className="h-3.5 w-3.5 text-brand-500" />
            </button>
          }
        />

        {participantsOpen && (
          <div className={`overflow-y-auto scrollbar-hide px-3 py-3 ${chatOpen ? 'flex-none max-h-[42%]' : 'flex-1 min-h-0'}`}>
            <ParticipantsList
              waiting={waiting}
              admitted={admitted}
              isHost={isHost}
              currentUserId={currentUserId}
              raisedHands={raisedHands}
              participantMedia={participantMedia}
              onAdmit={onAdmit}
              onDeny={onDeny}
              onForceMute={onForceMute}
              onRemove={onRemove}
              processingIds={processingIds}
              runAction={runAction}
            />
          </div>
        )}

        {/* ---- Discussion ---- */}
        <SectionHeader
          title="Discussion"
          count={chat.messages.length}
          open={chatOpen}
          onToggle={() => setChatOpen((v) => !v)}
          action={
            chat.unreadCount > 0 && !chatVisible ? (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-brand-500 text-white text-[11px] font-bold">
                {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
              </span>
            ) : null
          }
        />

        {chatOpen && (
          <ChatPanel
            messages={chat.messages}
            loading={chat.loading}
            currentUserId={currentUserId}
            onSend={chat.sendMessage}
            onToggleReaction={chat.toggleReaction}
          />
        )}
      </div>
    </>
  );
}

/** Icônes micro et caméra d'un participant, comme dans le template. */
function MediaState({ micOn, camOn }) {
  return (
    <span className="flex items-center gap-1.5 flex-none">
      <span className={micOn ? 'text-brand-500' : 'text-error-500'} title={micOn ? 'Micro ouvert' : 'Micro coupé'}>
        {micOn ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
      </span>
      <span className={camOn ? 'text-brand-500' : 'text-error-500'} title={camOn ? 'Caméra active' : 'Caméra coupée'}>
        {camOn ? <Video className="h-3.5 w-3.5" /> : <VideoOff className="h-3.5 w-3.5" />}
      </span>
    </span>
  );
}

function ParticipantsList({
  waiting, admitted, isHost, currentUserId, raisedHands, participantMedia,
  onAdmit, onDeny, onForceMute, onRemove, processingIds, runAction,
}) {
  // Les mains levées passent en tête : c'est tout l'intérêt du geste, l'hôte
  // doit les voir sans parcourir la liste.
  const ordered = [...admitted].sort((a, b) => {
    const aRaised = !!raisedHands?.[a.profile_id || a.guest_id];
    const bRaised = !!raisedHands?.[b.profile_id || b.guest_id];
    return Number(bRaised) - Number(aRaised);
  });

  return (
    <div className="flex flex-col gap-4">
      {isHost && waiting.length > 0 && (
        <div className="flex flex-col gap-3 border border-warning-500/35 bg-warning-50 rounded-md p-3.5">
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold tracking-overline uppercase text-warning-500">
            <span className="w-1.5 h-1.5 rounded-full bg-warning-500" />
            Salle d&apos;attente · {waiting.length}
          </span>
          <div className="flex flex-col gap-2.5">
            {waiting.map((w) => (
              <div key={w.id} className="flex items-center gap-2.5">
                <Avatar size="sm" name={w.display_name} seed={w.profile_id || w.guest_id || w.id} />
                <span className="flex-1 text-[13.5px] font-medium text-slate-950 truncate min-w-0">
                  {w.display_name}
                </span>
                <button
                  onClick={() => runAction(w.id, onAdmit)}
                  disabled={processingIds.has(w.id)}
                  className="flex-none text-[12px] font-semibold px-2.5 py-1.5 rounded-sm bg-brand-500 text-white hover:bg-brand-600 transition-colors disabled:opacity-50"
                >
                  {processingIds.has(w.id) ? '…' : 'Admettre'}
                </button>
                <button
                  onClick={() => runAction(w.id, onDeny)}
                  disabled={processingIds.has(w.id)}
                  title="Refuser"
                  className="flex-none w-7 h-7 rounded-sm bg-surface border border-slate-200 text-slate-500 hover:text-error-500 transition-colors disabled:opacity-50 flex items-center justify-center"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {ordered.map((p) => {
          const userId = p.profile_id || p.guest_id;
          const handRaised = !!raisedHands?.[userId];
          const media = participantMedia?.[userId] || { micOn: true, camOn: true };
          const isMe = userId === currentUserId;

          return (
            <div
              key={p.id}
              className={`flex items-center gap-2.5 py-2 px-2 rounded-md transition-colors group ${
                handRaised ? 'bg-warning-50 ring-1 ring-warning-500/30' : 'hover:bg-slate-50'
              }`}
            >
              <Avatar size="sm" name={p.display_name} seed={userId || p.id} />

              <div className="flex-1 flex items-center gap-2 min-w-0">
                <span className="text-[13.5px] font-medium text-slate-950 truncate">
                  {p.display_name}{isMe && ' (vous)'}
                </span>
                {(p.role === 'host' || p.role === 'co-host') && (
                  <span className="flex-none font-mono text-[9px] font-bold tracking-overline uppercase text-brand-500 bg-brand-50 rounded-xs px-1.5 py-0.5">
                    {p.role === 'host' ? 'Hôte' : 'Co-hôte'}
                  </span>
                )}
              </div>

              {handRaised && (
                <span className="flex-none text-warning-500 animate-pulse" title="A levé la main">
                  <Hand className="h-4 w-4" />
                </span>
              )}

              <MediaState micOn={media.micOn && !p.force_muted} camOn={media.camOn} />

              {isHost && p.role !== 'host' && (
                <div className="flex-none flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button
                    onClick={() => onForceMute?.(p.id)}
                    title={p.force_muted ? 'Réautoriser le micro' : 'Couper le micro'}
                    className="w-[26px] h-[26px] rounded-sm text-slate-500 hover:text-slate-950 hover:bg-slate-100 flex items-center justify-center"
                  >
                    {p.force_muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    onClick={() => onRemove?.(p.id)}
                    title="Exclure de la réunion"
                    className="w-[26px] h-[26px] rounded-sm text-slate-500 hover:text-error-500 hover:bg-slate-100 flex items-center justify-center"
                  >
                    <UserX className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
