'use client';

import { useEffect, useState } from 'react';
import { X, Mic, MicOff, UserX } from 'lucide-react';
import { initialsOf, avatarColorFor } from '@/lib/identity';
import useMeetingChat from '@/hooks/useMeetingChat';
import ChatPanel from './ChatPanel';

/**
 * Vrai quand le panneau latéral est affiché en colonne fixe (le point de
 * rupture `lg` de Tailwind), plutôt qu'en superposition mobile. Mesuré dans un
 * effet et non pendant le rendu, pour ne pas diverger du rendu serveur.
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
  onUnreadChange,
}) {
  const [tab, setTab] = useState('participants');
  const admitted = participants || [];
  const waiting = waitingParticipants || [];
  const totalCount = admitted.length + waiting.length;

  // Le chat est piloté ici, et non dans l'onglet Discussion : les onglets sont
  // montés/démontés par le ternaire plus bas, si bien qu'un état vivant dans
  // l'onglet serait détruit — et son abonnement socket coupé — dès qu'on
  // regarde la liste des participants.
  //
  // La discussion compte comme lue lorsqu'elle est réellement à l'écran :
  // onglet actif ET panneau visible. Sur grand écran le panneau est toujours
  // là ; sur mobile c'est une superposition qu'on peut refermer.
  const isWidePanel = useIsWidePanel();
  const chatVisible = tab === 'discussion' && (isWidePanel || mobileOpen);

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
            className={`relative flex-1 text-center py-3.5 text-[13.5px] font-mono transition-colors ${
              tab === 'discussion' ? 'text-white bg-ink-800 border-b-2 border-signal-500' : 'text-ink-500'
            }`}
          >
            Discussion
            {chat.unreadCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-signal-500 text-white text-[10px] font-bold align-middle">
                {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
              </span>
            )}
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

/** Pastille d'initiales, colorée de façon stable — même rendu que dans le chat. */
function Avatar({ name, seed }) {
  const color = avatarColorFor(seed || name);
  return (
    <span
      className="w-8 h-8 rounded-full font-mono text-[11px] font-bold flex items-center justify-center flex-none"
      style={{ background: color.bg, color: color.fg }}
      title={name}
    >
      {initialsOf(name)}
    </span>
  );
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
                <Avatar name={w.display_name} seed={w.profile_id || w.guest_id || w.id} />
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
            <Avatar name={p.display_name} seed={p.profile_id || p.guest_id || p.id} />
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
