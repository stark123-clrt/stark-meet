'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Monitor,
  MonitorOff,
  Hand,
  Lock,
  LockOpen,
  Settings,
  Copy,
  Check,
  Users,
} from 'lucide-react';
import VideoGrid from './VideoGrid';
import SidePanel from './SidePanel';
import DeviceSelector from './DeviceSelector';
import useMediasoup from '@/hooks/useMediasoup';

function formatElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function ctrlClass(on, danger = false) {
  const base = 'w-12 h-12 sm:w-[52px] sm:h-[52px] rounded-full flex items-center justify-center transition-colors flex-none';
  if (!on && danger) return `${base} bg-danger-500/15 border border-danger-500/45 text-danger-500`;
  return `${base} bg-white/[0.07] text-mist-300 hover:bg-white/[0.13] hover:text-white`;
}

function accentCtrlClass(active) {
  const base = 'w-12 h-12 sm:w-[52px] sm:h-[52px] rounded-full flex items-center justify-center transition-colors flex-none';
  return active
    ? `${base} bg-amber-500/15 border border-amber-500/45 text-amber-500`
    : `${base} bg-white/[0.07] text-mist-300 hover:bg-white/[0.13] hover:text-white`;
}

export default function ConferenceView({
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
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const hasJoinedRef = useRef(false);
  const joinedAtRef = useRef(null);

  const {
    localStream,
    remoteStreams,
    remotePeers,
    isMicOn,
    isVideoOn,
    isConnected,
    isScreenSharing,
    isHandRaised,
    raisedHands,
    remoteMediaState,
    isForceMuted: isForceMutedBySignal,
    error,
    joinMeeting,
    leaveMeeting,
    toggleMic,
    setMicEnabled,
    toggleVideo,
    toggleHand,
    startScreenShare,
    stopScreenShare,
  } = useMediasoup(meeting?.id, currentUserId, currentUserName);

  useEffect(() => {
    if (currentUserId && meeting?.id && !hasJoinedRef.current) {
      hasJoinedRef.current = true;
      joinMeeting();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, meeting?.id]);

  // Libérer caméra, micro et connexion même si la vue disparaît sans passer
  // par le bouton « Quitter » — c'est le cas quand l'hôte exclut quelqu'un :
  // la page bascule sur l'écran d'exclusion, et sans ça la webcam de la
  // personne restait allumée.
  const leaveMeetingRef = useRef(leaveMeeting);
  leaveMeetingRef.current = leaveMeeting;
  useEffect(() => () => leaveMeetingRef.current?.(), []);

  useEffect(() => {
    if (isConnected && !joinedAtRef.current) joinedAtRef.current = Date.now();
    if (!isConnected) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - joinedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isConnected]);

  // Ne montrer dans le panneau participants que ceux réellement connectés
  // à Mediasoup en ce moment (+ moi-même) — une ligne "admitted" en base
  // reste sinon indéfiniment si quelqu'un ferme l'onglet sans cliquer
  // "Quitter" (aucune déconnexion réseau ne met à jour son statut).
  const connectedParticipants = (participants || []).filter((p) => {
    const participantUserId = p.profile_id || p.guest_id;
    if (participantUserId === currentUserId) return true;
    return Object.values(remotePeers).some((peer) => peer.userId === participantUserId);
  });

  // Mute forcé par l'hôte. Deux sources concordantes : la ligne en base (qui
  // survit à un rechargement) et le signal direct du SFU (immédiat, et déjà
  // appliqué côté serveur). L'une ou l'autre suffit à couper.
  const myParticipantRow = participants?.find(
    (p) => (p.profile_id || p.guest_id) === currentUserId
  );
  const isForceMuted = !!myParticipantRow?.force_muted || isForceMutedBySignal;

  useEffect(() => {
    if (isForceMuted && isMicOn) {
      setMicEnabled(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isForceMuted, isMicOn]);

  const handleLeave = async () => {
    leaveMeeting();
    await onLeaveMeeting?.();
  };

  const copyCode = () => {
    navigator.clipboard.writeText(meeting?.meeting_code || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isLocked = !!meeting?.locked_at;
  const waitingCount = waitingParticipants?.length || 0;
  const totalCount = connectedParticipants.length + waitingCount;
  const initials = (currentUserName || '?').trim().slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-col h-full w-full bg-ink-950 overflow-hidden">
      <header className="flex-none flex items-center justify-between gap-3 px-3 sm:px-6 h-[60px] bg-ink-900 border-b border-ink-700">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <div className="hidden sm:flex items-center gap-2 font-mono font-bold text-[13.5px] tracking-wide text-white flex-none">
            <span className="w-1.5 h-1.5 rounded-full bg-signal-500 inline-block" />
            STARK MEET
          </div>
          <span className="hidden sm:block w-px h-6 bg-ink-700 flex-none" />
          <span className="text-[14.5px] font-semibold text-white truncate">{meeting?.title || 'Réunion'}</span>
          <button
            onClick={copyCode}
            className="flex items-center gap-1.5 font-mono text-[11.5px] text-mist-300 bg-white/[0.05] rounded px-2.5 py-1 hover:bg-white/[0.09] transition-colors flex-none"
          >
            {meeting?.meeting_code}
            {copied ? <Check className="h-3 w-3 text-ok-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>

        <div className="flex items-center gap-2 sm:gap-3.5 flex-none">
          {isConnected && (
            <span className="hidden sm:flex items-center gap-1.5 font-mono text-[11px] font-semibold text-ok-500 bg-ok-500/10 border border-ok-500/25 rounded px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-ok-500 inline-block" />
              EN DIRECT
            </span>
          )}
          {isConnected && (
            <span className="hidden md:inline font-mono text-[13px] text-mist-300 tabular-nums">
              {formatElapsed(elapsed)}
            </span>
          )}
          {isLocked && (
            <span className="hidden lg:flex items-center gap-1.5 font-mono text-[11px] font-semibold text-amber-500 bg-amber-500/10 border border-amber-500/28 rounded px-2.5 py-1">
              <Lock className="h-3 w-3" />
              SALLE VERROUILLÉE
            </span>
          )}
          <button
            onClick={() => setShowDeviceSelector(true)}
            className="p-2 rounded-md text-ink-500 hover:text-white hover:bg-ink-800 transition-colors"
            title="Paramètres des périphériques"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={() => setMobilePanelOpen(true)}
            className="lg:hidden relative p-2 rounded-md text-ink-500 hover:text-white hover:bg-ink-800 transition-colors"
            title="Participants et discussion"
          >
            <Users className="h-4 w-4" />
            {waitingCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-ink-950 text-[9px] font-bold flex items-center justify-center">
                {waitingCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {error && (
        <div className="flex-none bg-signal-500/10 border-b border-signal-500/20 text-signal-300 px-5 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {currentUserId ? (
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
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-ink-500">Chargement…</div>
        )}

        <SidePanel
          meetingId={meeting?.id}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          isHost={isHost}
          roomChannel={roomChannel}
          participants={connectedParticipants}
          waitingParticipants={waitingParticipants}
          onAdmit={onAdmit}
          onDeny={onDeny}
          onForceMute={onForceMute}
          onRemove={onRemove}
          mobileOpen={mobilePanelOpen}
          onCloseMobile={() => setMobilePanelOpen(false)}
        />
      </div>

      {showDeviceSelector && <DeviceSelector onClose={() => setShowDeviceSelector(false)} />}

      <footer className="flex-none flex items-center justify-between gap-2 px-3 sm:px-6 h-auto sm:h-[82px] py-2.5 sm:py-0 bg-ink-900 border-t border-ink-700">
        <div className="hidden md:flex items-center gap-2.5 w-[280px] flex-none">
          <span className="w-[30px] h-[30px] rounded-full bg-ink-800 text-white font-mono text-[11px] font-semibold flex items-center justify-center flex-none">
            {initials}
          </span>
          <div className="flex flex-col min-w-0">
            <span className="text-[13px] text-white truncate">{currentUserName}</span>
            <span className="font-mono text-[10.5px] text-ink-600">
              {isHost ? 'HÔTE DE LA RÉUNION' : 'PARTICIPANT'}
            </span>
          </div>
        </div>

        <div className="flex-1 md:flex-none flex items-center justify-center gap-2 sm:gap-3 overflow-x-auto scrollbar-hide">
          <button
            onClick={toggleMic}
            disabled={isForceMuted}
            title={isForceMuted ? "Micro coupé par l'hôte" : 'Micro'}
            className={`${ctrlClass(isMicOn, true)} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isMicOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </button>

          <button onClick={toggleVideo} disabled={isScreenSharing} title="Caméra" className={`${ctrlClass(isVideoOn, true)} disabled:opacity-40`}>
            {isVideoOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </button>

          <button
            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
            title="Partager l'écran"
            className={isScreenSharing ? accentCtrlClass(true) : ctrlClass(true)}
          >
            {isScreenSharing ? <MonitorOff className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
          </button>

          <button onClick={toggleHand} title="Lever la main" className={accentCtrlClass(isHandRaised)}>
            <Hand className="h-5 w-5" />
          </button>

          {isHost && (
            <button
              onClick={onToggleLock}
              title={isLocked ? 'Verrouillée — cliquer pour déverrouiller' : 'Verrouiller la salle'}
              className={accentCtrlClass(isLocked)}
            >
              {isLocked ? <Lock className="h-5 w-5" /> : <LockOpen className="h-5 w-5" />}
            </button>
          )}

          <span className="w-px h-8 bg-ink-700 mx-1 flex-none" />

          <button
            onClick={handleLeave}
            className="flex-none flex items-center gap-2 h-12 sm:h-[52px] px-4 sm:px-[22px] rounded-full bg-signal-500 hover:bg-signal-600 text-white text-[13.5px] font-semibold transition-colors"
          >
            <PhoneOff className="h-4 w-4" />
            <span className="hidden sm:inline">Quitter</span>
          </button>
        </div>

        <div className="hidden md:block w-[280px] flex-none" />
      </footer>
    </div>
  );
}
