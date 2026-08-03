'use client';

import { useMemo } from 'react';
import { User } from 'lucide-react';
import VideoCard from './VideoCard';

/**
 * VideoGrid — grille des vidéos : ma tuile + celles des participants
 * distants. Le nom/rôle de chaque participant distant est retrouvé via
 * `remotePeers` (userId transmis par mediasoup) croisé avec la liste des
 * participants de la réunion (Supabase).
 */
export default function VideoGrid({
  participants,
  remotePeers,
  localStream,
  remoteStreams,
  currentUserId,
  onToggleMic,
  onToggleVideo,
  isMicOn,
  isVideoOn,
}) {
  const currentUserData = useMemo(() => {
    if (!localStream || !currentUserId) return null;

    const currentParticipant = participants?.find(p => p.profile_id === currentUserId || p.guest_id === currentUserId);
    if (!currentParticipant) return null;

    return {
      participant: {
        id: currentParticipant.id,
        name: currentParticipant.display_name || 'Vous',
        role: currentParticipant.role,
      },
      stream: localStream,
    };
  }, [participants, currentUserId, localStream]);

  const remoteParticipantsData = Object.entries(remoteStreams).map(([peerId, stream]) => {
    const peerInfo = remotePeers?.[peerId];
    const matchedParticipant = peerInfo?.userId
      ? participants?.find(p => p.profile_id === peerInfo.userId || p.guest_id === peerInfo.userId)
      : null;

    return {
      participant: {
        id: peerId,
        name: matchedParticipant?.display_name || peerInfo?.name || 'Participant',
        role: matchedParticipant?.role || 'guest',
      },
      stream,
    };
  });

  return (
    <div className="h-full w-full overflow-y-auto scrollbar-hide bg-ink-950">
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {currentUserData && (
          <div key={currentUserData.participant.id || 'local'} className="relative min-h-[190px]">
            <VideoCard
              participant={currentUserData.participant}
              stream={currentUserData.stream}
              isLocal={true}
              micEnabled={isMicOn}
              videoEnabled={isVideoOn}
              onToggleMic={onToggleMic}
              onToggleVideo={onToggleVideo}
            />
          </div>
        )}
        {remoteParticipantsData.map((data) => (
          <div key={data.participant.id} className="relative min-h-[190px]">
            <VideoCard participant={data.participant} stream={data.stream} isLocal={false} />
          </div>
        ))}
      </div>

      {remoteParticipantsData.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-ink-800 flex items-center justify-center mx-auto mb-4 border border-ink-700">
              <User className="h-7 w-7 text-ink-500" />
            </div>
            <p className="text-mist-300 text-base font-medium">En attente d'autres participants…</p>
            <p className="text-ink-500 text-sm mt-1.5">Partagez le code ou le lien de la réunion.</p>
          </div>
        </div>
      )}
    </div>
  );
}
