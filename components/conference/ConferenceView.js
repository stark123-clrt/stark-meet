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
  MessageSquare,
  Users,
  Lock,
  LockOpen,
  Settings,
} from 'lucide-react';
import VideoGrid from './VideoGrid';
import ParticipantsList from './ParticipantsList';
import ChatPanel from './ChatPanel';
import DeviceSelector from './DeviceSelector';
import useMediasoup from '@/hooks/useMediasoup';

export default function ConferenceView({
  meeting,
  currentUserId,
  currentUserName,
  isHost,
  participants,
  waitingParticipants,
  onLeaveMeeting,
  onToggleLock,
  onAdmit,
  onDeny,
  onForceMute,
  onRemove,
}) {
  const [showParticipants, setShowParticipants] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showDeviceSelector, setShowDeviceSelector] = useState(false);
  const hasJoinedRef = useRef(false);

  const {
    localStream,
    remoteStreams,
    remotePeers,
    isMicOn,
    isVideoOn,
    isConnected,
    isScreenSharing,
    error,
    joinMeeting,
    leaveMeeting,
    toggleMic,
    toggleVideo,
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

  const handleLeave = async () => {
    leaveMeeting();
    await onLeaveMeeting?.();
  };

  const isLocked = !!meeting?.locked_at;
  const waitingCount = waitingParticipants?.length || 0;

  return (
    <div className="flex flex-col h-full w-full bg-ink-950">
      <header className="flex items-center justify-between px-5 py-3 bg-ink-900 border-b border-ink-700">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-white text-sm font-semibold truncate">{meeting?.title || 'Réunion'}</h1>
          <span className="text-ink-500 font-mono text-xs hidden sm:inline">{meeting?.meeting_code}</span>
          {isConnected && (
            <span className="flex items-center gap-1.5 text-ok-500 text-[11px] font-mono uppercase tracking-wide">
              <span className="w-1.5 h-1.5 bg-ok-500 rounded-full" />
              En direct
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {isHost && (
            <button
              onClick={onToggleLock}
              className={`p-2 rounded-md transition-colors ${
                isLocked ? 'bg-signal-500/15 text-signal-300' : 'text-ink-500 hover:text-white hover:bg-ink-800'
              }`}
              title={isLocked ? 'Salle verrouillée — cliquer pour déverrouiller' : 'Verrouiller la salle'}
            >
              {isLocked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
            </button>
          )}
          <button
            onClick={() => setShowDeviceSelector(true)}
            className="p-2 rounded-md text-ink-500 hover:text-white hover:bg-ink-800 transition-colors"
            title="Paramètres des périphériques"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            className={`p-2 rounded-md transition-colors ${showChat ? 'bg-ink-800 text-white' : 'text-ink-500 hover:text-white hover:bg-ink-800'}`}
            title="Discussion"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowParticipants(!showParticipants)}
            className={`relative p-2 rounded-md transition-colors ${showParticipants ? 'bg-ink-800 text-white' : 'text-ink-500 hover:text-white hover:bg-ink-800'}`}
            title="Participants"
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
        <div className="bg-signal-500/10 border-b border-signal-500/20 text-signal-300 px-5 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 relative overflow-hidden">
          {currentUserId ? (
            <VideoGrid
              participants={participants}
              remotePeers={remotePeers}
              localStream={localStream}
              remoteStreams={remoteStreams}
              currentUserId={currentUserId}
              onToggleMic={toggleMic}
              onToggleVideo={toggleVideo}
              isMicOn={isMicOn}
              isVideoOn={isVideoOn}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-ink-500">Chargement…</div>
          )}

          {showParticipants && (
            <ParticipantsList
              onClose={() => setShowParticipants(false)}
              participants={participants}
              waitingParticipants={waitingParticipants}
              isHost={isHost}
              onAdmit={onAdmit}
              onDeny={onDeny}
              onForceMute={onForceMute}
              onRemove={onRemove}
            />
          )}

          {showDeviceSelector && <DeviceSelector onClose={() => setShowDeviceSelector(false)} />}
        </main>

        <ChatPanel
          meetingId={meeting?.id}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          isOpen={showChat}
          onClose={() => setShowChat(false)}
        />
      </div>

      <footer className="flex items-center justify-center gap-2.5 px-4 py-3 bg-ink-900 border-t border-ink-700">
        <button
          onClick={toggleMic}
          className={`flex flex-col items-center gap-1 w-16 py-2 rounded-lg transition-colors ${
            isMicOn ? 'bg-ink-800 text-mist-300 hover:text-white' : 'bg-signal-500 text-white'
          }`}
        >
          {isMicOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          <span className="text-[10px] font-medium">{isMicOn ? 'Micro' : 'Muet'}</span>
        </button>

        <button
          onClick={toggleVideo}
          disabled={isScreenSharing}
          className={`flex flex-col items-center gap-1 w-16 py-2 rounded-lg transition-colors disabled:opacity-40 ${
            isVideoOn ? 'bg-ink-800 text-mist-300 hover:text-white' : 'bg-signal-500 text-white'
          }`}
        >
          {isVideoOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          <span className="text-[10px] font-medium">Caméra</span>
        </button>

        <button
          onClick={isScreenSharing ? stopScreenShare : startScreenShare}
          className={`flex flex-col items-center gap-1 w-16 py-2 rounded-lg transition-colors ${
            isScreenSharing ? 'bg-signal-500 text-white' : 'bg-ink-800 text-mist-300 hover:text-white'
          }`}
        >
          {isScreenSharing ? <MonitorOff className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
          <span className="text-[10px] font-medium">Partager</span>
        </button>

        <div className="w-px h-8 bg-ink-700 mx-1" />

        <button
          onClick={handleLeave}
          className="flex flex-col items-center gap-1 w-16 py-2 rounded-lg bg-signal-500 hover:bg-signal-400 text-white transition-colors"
        >
          <PhoneOff className="h-4 w-4" />
          <span className="text-[10px] font-medium">Quitter</span>
        </button>
      </footer>
    </div>
  );
}
