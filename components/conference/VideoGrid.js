'use client';

import { useEffect, useMemo, useState } from 'react';
import { User } from 'lucide-react';
import VideoCard from './VideoCard';

/**
 * VideoGrid — scène principale (le participant "à l'écran") + bandeau de
 * vignettes cliquables en dessous pour changer qui est mis en avant.
 * Reproduit la mise en page du template Claude Design (spotlight + filmstrip)
 * plutôt qu'une grille uniforme.
 */
export default function VideoGrid({
  participants,
  remotePeers,
  localStream,
  remoteStreams,
  currentUserId,
  isMicOn,
  isVideoOn,
  raisedHands,
  remoteMediaState,
}) {
  const findParticipant = (userId) =>
    participants?.find((p) => p.profile_id === userId || p.guest_id === userId);

  const tiles = useMemo(() => {
    const list = [];

    const me = findParticipant(currentUserId);
    if (localStream && currentUserId) {
      list.push({
        tileId: 'local',
        participant: {
          id: me?.id || 'local',
          name: me?.display_name || 'Vous',
          role: me?.role || 'guest',
        },
        stream: localStream,
        isLocal: true,
        handRaised: !!raisedHands?.[currentUserId],
      });
    }

    Object.entries(remoteStreams || {}).forEach(([peerId, stream]) => {
      const peerInfo = remotePeers?.[peerId];
      const matched = peerInfo?.userId ? findParticipant(peerInfo.userId) : null;
      const media = remoteMediaState?.[peerId] || {};
      list.push({
        tileId: peerId,
        participant: {
          id: peerId,
          name: matched?.display_name || peerInfo?.name || 'Participant',
          role: matched?.role || 'guest',
        },
        stream,
        isLocal: false,
        handRaised: !!raisedHands?.[peerInfo?.userId],
        // `force_muted` en base couvre le cas où l'hôte coupe quelqu'un qui
        // n'a pas encore de flux audio actif.
        micEnabled: !media.audioPaused && !matched?.force_muted,
        videoEnabled: !media.videoPaused,
      });
    });

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, remotePeers, remoteStreams, localStream, currentUserId, raisedHands, remoteMediaState]);

  const [activeId, setActiveId] = useState(null);

  useEffect(() => {
    if (tiles.length === 0) return;
    if (!tiles.some((t) => t.tileId === activeId)) {
      const firstRemote = tiles.find((t) => !t.isLocal);
      setActiveId((firstRemote || tiles[0]).tileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles]);

  const active = tiles.find((t) => t.tileId === activeId) || tiles[0];
  const remoteCount = tiles.filter((t) => !t.isLocal).length;

  if (!active) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-ink-800 flex items-center justify-center mx-auto mb-4 border border-ink-700">
            <User className="h-7 w-7 text-ink-500" />
          </div>
          <p className="text-mist-300 text-base font-medium">Connexion à la réunion…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 pt-3 sm:pt-5 px-3 sm:px-5">
      <div className="flex-1 min-h-0">
        <VideoCard
          key={active.tileId}
          variant="stage"
          participant={active.participant}
          stream={active.stream}
          isLocal={active.isLocal}
          videoEnabled={active.isLocal ? isVideoOn : active.videoEnabled}
          micEnabled={active.isLocal ? isMicOn : active.micEnabled}
        />
      </div>

      {remoteCount > 0 && (
        <div className="flex-none flex gap-2.5 sm:gap-3 py-3 sm:py-4 overflow-x-auto scrollbar-hide">
          {tiles.map((t) => (
            <VideoCard
              key={t.tileId}
              variant="tile"
              participant={t.participant}
              stream={t.stream}
              isLocal={t.isLocal}
              videoEnabled={t.isLocal ? isVideoOn : t.videoEnabled}
              micEnabled={t.isLocal ? isMicOn : t.micEnabled}
              isActiveSpeaker={t.tileId === active.tileId}
              onSelect={() => setActiveId(t.tileId)}
            />
          ))}
        </div>
      )}

      {remoteCount === 0 && (
        <div className="flex-none py-4 sm:py-5 text-center">
          <p className="text-mist-300 text-sm font-medium">En attente d'autres participants…</p>
          <p className="text-ink-500 text-xs mt-1">Partagez le code ou le lien de la réunion.</p>
        </div>
      )}
    </div>
  );
}
