'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff, PhoneOff, Monitor, MonitorOff, Hand,
  Lock, LockOpen, Settings, Copy, Check, Users, X, Circle,
} from 'lucide-react';
import VideoGrid from './VideoGrid';
import SidePanel from './SidePanel';
import DeviceSelector from './DeviceSelector';
import Avatar from '@/components/ui/Avatar';
import { formatDateTime } from '@/lib/datetime';

function formatElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Bouton circulaire de la barre de contrôle. */
function Control({ icon: Icon, label, onClick, disabled, active = true, tone = 'neutral' }) {
  const base =
    'w-12 h-12 rounded-full flex items-center justify-center flex-none transition-colors duration-200 ease-standard disabled:opacity-40 disabled:cursor-not-allowed';

  // Micro et caméra actifs sont en bleu plein, comme dans le template : ce sont
  // les deux réglages qu'on cherche du regard en permanence, et un fond neutre
  // ne disait pas assez clairement « c'est ouvert ».
  const tones = {
    neutral: active
      ? 'bg-brand-500 text-white hover:bg-brand-600'
      : 'bg-error-500 text-white hover:brightness-110',
    accent: active
      ? 'bg-brand-50 text-brand-500 hover:brightness-95'
      : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
    warning: active
      ? 'bg-warning-500 text-white hover:brightness-110'
      : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
    record: 'bg-error-50 text-error-500 ring-1 ring-error-500/30',
  };

  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label} className={`${base} ${tones[tone]}`}>
      <Icon className="h-5 w-5" />
    </button>
  );
}

export default function ConferenceView({
  media,
  meeting,
  currentUserId,
  currentUserName,
  isHost,
  roomChannel,
  participants,
  waitingParticipants,
  onLeaveMeeting,
  onToggleLock,
  onAdmit,
  onDeny,
  onForceMute,
  onRemove,
}) {
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [showDeviceSelector, setShowDeviceSelector] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const joinedAtRef = useRef(null);

  const {
    localStream, remoteStreams, remotePeers,
    isMicOn, isVideoOn, isConnected, isScreenSharing, isHandRaised,
    raisedHands, remoteMediaState, remoteScreenShares,
    isForceMuted: isForceMutedBySignal, isReconnecting,
    error, clearError, canShareScreen,
    leaveMeeting, toggleMic, setMicEnabled, toggleVideo, toggleHand,
    startScreenShare, stopScreenShare,
  } = media;

  useEffect(() => {
    if (isConnected && !joinedAtRef.current) joinedAtRef.current = Date.now();
    if (!isConnected) return;

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - joinedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isConnected]);

  // Un message d'erreur concerne une action ponctuelle : il ne doit pas rester
  // affiché pour le reste de la réunion.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => clearError?.(), 8000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  // Ne montrer que les participants réellement connectés au SFU (+ moi) : une
  // ligne « admitted » en base survit indéfiniment à un onglet fermé sans
  // clic sur « Quitter ».
  const connectedParticipants = (participants || []).filter((p) => {
    const participantUserId = p.profile_id || p.guest_id;
    if (participantUserId === currentUserId) return true;
    return Object.values(remotePeers).some((peer) => peer.userId === participantUserId);
  });

  // Mute forcé : deux sources concordantes — la ligne en base (qui survit à un
  // rechargement) et le signal direct du SFU (immédiat, déjà appliqué serveur).
  // État micro/caméra indexé par utilisateur, pour la liste des participants.
  // Le SFU raisonne en `peerId` (identifiant de socket) alors que la liste
  // vient de la base et raisonne en profile_id/guest_id : cette table fait le
  // pont, et y ajoute mon propre état, que le SFU ne m'annonce pas à moi-même.
  const participantMedia = {};
  for (const [peerId, peer] of Object.entries(remotePeers)) {
    if (!peer.userId) continue;
    const state = remoteMediaState?.[peerId] || {};
    participantMedia[peer.userId] = {
      micOn: !state.audioPaused,
      camOn: !state.videoPaused,
    };
  }
  if (currentUserId) {
    participantMedia[currentUserId] = { micOn: isMicOn, camOn: isVideoOn };
  }

  const myParticipantRow = participants?.find((p) => (p.profile_id || p.guest_id) === currentUserId);
  const isForceMuted = !!myParticipantRow?.force_muted || isForceMutedBySignal;

  useEffect(() => {
    if (isForceMuted && isMicOn) setMicEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isForceMuted, isMicOn]);

  const handleLeave = async () => {
    leaveMeeting();
    await onLeaveMeeting?.();
  };

  const copyCode = () => {
    navigator.clipboard.writeText(`${window.location.origin}/room/${meeting?.meeting_code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isLocked = !!meeting?.locked_at;
  const waitingCount = waitingParticipants?.length || 0;

  return (
    <div className="flex flex-col h-screen w-full bg-canvas text-slate-950 overflow-hidden">
      {/* ---- En-tête ---- */}
      <header className="flex-none flex items-center gap-3 sm:gap-5 px-4 sm:px-6 h-[68px] bg-surface border-b border-slate-200">
        <div className="min-w-0 flex-1 sm:flex-none">
          <h1 className="text-[15px] font-medium truncate">{meeting?.title || 'Réunion'}</h1>
          <p className="text-[12px] text-slate-500 truncate">
            {meeting?.scheduled_at ? formatDateTime(meeting.scheduled_at) : 'Réunion instantanée'}
          </p>
        </div>

        <div className="hidden lg:flex items-center">
          {connectedParticipants.slice(0, 4).map((p) => (
            <Avatar
              key={p.id}
              size="sm"
              ring
              className="-mr-2"
              name={p.display_name}
              seed={p.profile_id || p.guest_id || p.id}
            />
          ))}
          {connectedParticipants.length > 4 && (
            <span className="-mr-2 w-8 h-8 rounded-full border-2 border-surface bg-slate-100 text-slate-700 font-mono text-[10px] font-bold flex items-center justify-center">
              +{connectedParticipants.length - 4}
            </span>
          )}
        </div>

        <button
          onClick={copyCode}
          title="Copier le lien d'invitation"
          className="hidden sm:flex items-center gap-2 h-9 px-3 rounded-sm bg-brand-50 text-brand-500 font-mono text-[12.5px] hover:brightness-95 transition"
        >
          {meeting?.meeting_code}
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {isConnected && (
            <span className="hidden md:inline font-mono text-[13px] text-slate-700 tabular-nums">
              {formatElapsed(elapsed)}
            </span>
          )}
          {isLocked && (
            <span className="hidden lg:flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-overline uppercase text-warning-500 bg-warning-50 rounded-xs px-2 py-1">
              <Lock className="h-3 w-3" /> Verrouillée
            </span>
          )}

          {/* Carte d'identité, à droite de l'en-tête comme dans le template :
              elle rappelle sous quel nom et quel rôle on est dans la salle. */}
          <div className="hidden xl:flex items-center gap-2.5 h-11 pl-2.5 pr-3 rounded-md border border-slate-200 bg-slate-50">
            <Avatar size="sm" name={currentUserName} seed={currentUserId} />
            <div className="flex flex-col min-w-0 max-w-[130px]">
              <span className="text-[13px] font-medium truncate leading-tight">{currentUserName}</span>
              <span className="text-[11.5px] text-slate-500 leading-tight">
                {isHost ? 'Modérateur' : 'Participant'}
              </span>
            </div>
          </div>

          <button
            onClick={() => setShowDeviceSelector(true)}
            title="Périphériques"
            className="p-2 rounded-sm text-slate-500 hover:text-slate-950 hover:bg-slate-100 transition-colors"
          >
            <Settings className="h-4 w-4" />
          </button>

          <button
            onClick={() => setMobilePanelOpen(true)}
            title="Participants et discussion"
            className="lg:hidden relative p-2 rounded-sm text-slate-500 hover:text-slate-950 hover:bg-slate-100 transition-colors"
          >
            <Users className="h-4 w-4" />
            {/* Le panneau est masqué sur mobile : sans ce cumul, un message de
                chat resterait invisible. Les demandes d'admission gardent la
                priorité de couleur. */}
            {waitingCount + unreadMessages > 0 && (
              <span
                className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold flex items-center justify-center ${
                  waitingCount > 0 ? 'bg-warning-500 text-white' : 'bg-brand-500 text-white'
                }`}
              >
                {waitingCount + unreadMessages}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Coupure réseau : la session est en cours de reconstruction. Le dire
          explicitement évite qu'un silence soudain passe pour une panne — et
          surtout, l'ancien comportement affichait « connecté » alors que la
          personne était sortie de la réunion sans le savoir. */}
      {isReconnecting && (
        <div className="flex-none flex items-center gap-3 bg-warning-50 border-b border-warning-500/25 px-5 py-2.5 text-[13.5px] text-slate-700">
          <span className="w-2 h-2 rounded-full bg-warning-500 animate-pulse flex-none" />
          Connexion interrompue — reprise de la réunion en cours…
        </div>
      )}

      {error && !isReconnecting && (
        <div className="flex-none flex items-start gap-3 bg-warning-50 border-b border-warning-500/20 px-5 py-2.5 text-[13.5px] text-slate-700">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} title="Masquer" className="flex-none p-0.5 rounded-sm hover:bg-black/5">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ---- Scène + panneau ---- */}
      <div className="flex-1 flex min-h-0">
        <VideoGrid
          participants={participants}
          remotePeers={remotePeers}
          localStream={localStream}
          remoteStreams={remoteStreams}
          currentUserId={currentUserId}
          isMicOn={isMicOn}
          isVideoOn={isVideoOn}
          raisedHands={raisedHands}
          remoteMediaState={remoteMediaState}
          remoteScreenShares={remoteScreenShares}
          isScreenSharing={isScreenSharing}
        />

        <SidePanel
          meetingId={meeting?.id}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          isHost={isHost}
          roomChannel={roomChannel}
          participants={connectedParticipants}
          waitingParticipants={waitingParticipants}
          raisedHands={raisedHands}
          participantMedia={participantMedia}
          onAdmit={onAdmit}
          onDeny={onDeny}
          onForceMute={onForceMute}
          onRemove={onRemove}
          mobileOpen={mobilePanelOpen}
          onCloseMobile={() => setMobilePanelOpen(false)}
          onUnreadChange={setUnreadMessages}
          onCopyInvite={copyCode}
        />
      </div>

      {showDeviceSelector && <DeviceSelector onClose={() => setShowDeviceSelector(false)} />}

      {/* ---- Barre de contrôle ---- */}
      <footer className="flex-none flex items-center justify-between gap-2 px-4 sm:px-6 h-auto sm:h-[84px] py-3 sm:py-0 bg-surface border-t border-slate-200">
        <div className="hidden md:flex items-center gap-2.5 w-[260px] flex-none">
          <Avatar size="sm" name={currentUserName} seed={currentUserId} />
          <div className="flex flex-col min-w-0">
            <span className="text-[13.5px] font-medium truncate">{currentUserName}</span>
            <span className="text-[11.5px] text-slate-500">
              {isHost ? 'Modérateur' : 'Participant'}
            </span>
          </div>
        </div>

        <div className="flex-1 md:flex-none flex items-center justify-center gap-2 sm:gap-3 overflow-x-auto scrollbar-hide">
          <Control
            icon={isMicOn ? Mic : MicOff}
            label={isForceMuted ? "Micro coupé par l'hôte" : 'Micro'}
            onClick={toggleMic}
            disabled={isForceMuted}
            active={isMicOn}
          />
          <Control
            icon={isVideoOn ? Video : VideoOff}
            label="Caméra"
            onClick={toggleVideo}
            disabled={isScreenSharing}
            active={isVideoOn}
          />
          {/* Bleu clair = disponible, bleu plein = partage en cours. */}
          <Control
            icon={isScreenSharing ? MonitorOff : Monitor}
            label={canShareScreen ? "Partager l'écran" : "Partage d'écran indisponible sur ce navigateur"}
            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
            disabled={!canShareScreen && !isScreenSharing}
            tone={isScreenSharing ? 'neutral' : 'accent'}
            active
          />
          {/* L'enregistrement figure dans le template mais n'existe pas encore :
              bouton présent et désactivé, plutôt qu'une action qui échouerait. */}
          <Control
            icon={Circle}
            label="Enregistrement — arrivera avec le plan Équipe"
            tone="record"
            disabled
          />
          <Control
            icon={Hand}
            label="Lever la main"
            onClick={toggleHand}
            tone="warning"
            active={isHandRaised}
          />
          {isHost && (
            <Control
              icon={isLocked ? Lock : LockOpen}
              label={isLocked ? 'Déverrouiller la salle' : 'Verrouiller la salle'}
              onClick={onToggleLock}
              tone="warning"
              active={isLocked}
            />
          )}

          <span className="w-px h-8 bg-slate-200 mx-1 flex-none" />

          <button
            onClick={handleLeave}
            className="flex-none flex items-center gap-2 h-12 px-4 sm:px-6 rounded-full bg-error-500 text-white text-[13.5px] font-semibold hover:brightness-110 transition"
          >
            <PhoneOff className="h-4 w-4" />
            <span className="hidden sm:inline">Quitter l&apos;appel</span>
          </button>
        </div>

        <div className="hidden md:block w-[260px] flex-none" />
      </footer>
    </div>
  );
}
