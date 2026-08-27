'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pin, PinOff, MonitorUp } from 'lucide-react';
import VideoCard from './VideoCard';
import useElementSize from '@/hooks/useElementSize';
import { bestGridLayout } from '@/lib/gridLayout';

const TILE_GAP = 12;

/**
 * VideoGrid — disposition de la scène.
 *
 * Trois modes, dans cet ordre de priorité :
 *
 *  1. Épinglage manuel — l'utilisateur a explicitement choisi qui regarder.
 *     Décision purement locale : rien n'est envoyé au serveur, les autres
 *     participants gardent leur propre disposition.
 *  2. Partage d'écran — mis en avant automatiquement. Un écran partagé
 *     contient du texte, illisible dans une petite tuile ; l'égalité devient
 *     contre-productive à ce moment précis.
 *  3. Grille égalitaire — le défaut. Tout le monde à la même taille.
 *
 * Quand un partage démarre, un épinglage en cours est levé pour que la
 * présentation soit vue ; l'utilisateur peut ensuite ré-épingler qui il veut,
 * et son choix explicite prime alors sur l'automatisme.
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
  remoteScreenShares,
  isScreenSharing,
  audioOutputId,
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
        isScreenShare: !!isScreenSharing,
        micEnabled: isMicOn,
        videoEnabled: isVideoOn,
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
        isScreenShare: !!remoteScreenShares?.[peerId],
        // `force_muted` en base couvre le cas où l'hôte coupe quelqu'un qui
        // n'a pas encore de flux audio actif.
        micEnabled: !media.audioPaused && !matched?.force_muted,
        videoEnabled: !media.videoPaused,
      });
    });

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    participants, remotePeers, remoteStreams, localStream, currentUserId,
    raisedHands, remoteMediaState, remoteScreenShares, isScreenSharing, isMicOn, isVideoOn,
  ]);

  const [pinnedId, setPinnedId] = useState(null);
  // Vue interlocuteur : qui occupe le grand cadre, l'autre ou moi.
  const [duoSwapped, setDuoSwapped] = useState(false);

  const sharingTile = tiles.find((t) => t.isScreenShare) || null;

  // Un partage qui démarre lève l'épinglage en cours : sans ça, quelqu'un qui
  // avait épinglé un visage ne verrait jamais la présentation commencer.
  // Ré-épingler ensuite reste possible, et reprend la main.
  const previousSharingIdRef = useRef(null);
  useEffect(() => {
    const sharingId = sharingTile?.tileId || null;
    if (sharingId && sharingId !== previousSharingIdRef.current) setPinnedId(null);
    previousSharingIdRef.current = sharingId;
  }, [sharingTile?.tileId]);

  // Un épinglage sur quelqu'un qui a quitté la salle doit se lever tout seul.
  const pinnedTile = tiles.find((t) => t.tileId === pinnedId) || null;
  const spotlightTile = pinnedTile || sharingTile;

  const togglePin = (tileId) => setPinnedId((current) => (current === tileId ? null : tileId));

  const [gridRef, gridSize] = useElementSize();
  const layout = bestGridLayout({
    count: tiles.length,
    width: gridSize.width,
    height: gridSize.height,
    gap: TILE_GAP,
  });

  if (tiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
            <MonitorUp className="h-7 w-7 text-slate-500" />
          </div>
          <p className="text-slate-700 text-base font-medium">Connexion à la réunion…</p>
        </div>
      </div>
    );
  }

  // ---- Mode mise en avant (épinglage ou partage d'écran) ----
  if (spotlightTile) {
    return (
      <div className="flex-1 flex flex-col min-h-0 pt-3 sm:pt-5 px-3 sm:px-5">
        <div className="flex-none flex items-center gap-2 pb-2">
          {pinnedTile ? (
            <button
              onClick={() => setPinnedId(null)}
              className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold tracking-wide text-brand-500 bg-brand-50 border border-brand-500/30 rounded-sm px-2.5 py-1 hover:brightness-95 transition-colors"
            >
              <PinOff className="h-3 w-3" />
              ÉPINGLÉ · DÉTACHER
            </button>
          ) : (
            // Bleu et non ambre : un partage d'écran en cours est une
            // information, pas un avertissement. L'ambre reste réservé à ce qui
            // demande une action — main levée, salle d'attente, coupure réseau.
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold tracking-overline uppercase text-brand-500 bg-brand-50 border border-brand-500/25 rounded-sm px-2.5 py-1">
              <MonitorUp className="h-3 w-3" />
              PARTAGE D&apos;ÉCRAN
            </span>
          )}
        </div>

        {/* En portrait mobile, la scène ne doit pas manger toute la hauteur :
            au-delà de ~52 %, le bandeau de vignettes et la barre de contrôle
            passaient sous la ligne de flottaison. Et un écran partagé affiché
            en entier laisse de larges bandes noires — les plafonner les réduit
            au lieu de les étirer. */}
        <div className="flex-1 min-h-0 max-h-[52vh] sm:max-h-none">
          <VideoCard
            key={spotlightTile.tileId}
            variant="stage"
            participant={spotlightTile.participant}
            stream={spotlightTile.stream}
            isLocal={spotlightTile.isLocal}
            videoEnabled={spotlightTile.videoEnabled}
            micEnabled={spotlightTile.micEnabled}
            handRaised={spotlightTile.handRaised}
            isScreenShare={spotlightTile.isScreenShare}
            // La personne mise en avant est AUSSI dans le bandeau du bas :
            // c'est la vignette qui porte l'audio, sinon le flux serait joué
            // deux fois et sonnerait dédoublé.
            playAudio={false}
            audioOutputId={audioOutputId}
          />
        </div>

        <div className="flex-none flex gap-2.5 sm:gap-3 py-3 sm:py-4 overflow-x-auto scrollbar-hide">
          {tiles.map((tile) => (
            <TileWithPin
              key={tile.tileId}
              tile={tile}
              variant="tile"
              isPinned={pinnedId === tile.tileId}
              isSpotlighted={tile.tileId === spotlightTile.tileId}
              audioOutputId={audioOutputId}
              onTogglePin={() => togglePin(tile.tileId)}
            />
          ))}
        </div>
      </div>
    );
  }

  // ---- Vue interlocuteur : deux participants sur un écran en portrait ----
  // À deux, une grille égalitaire n'a aucune valeur : on sait déjà à quoi on
  // ressemble. Toute la surface doit servir à voir l'autre — c'est ce que font
  // Meet, Zoom, WhatsApp et FaceTime sur téléphone, sans exception. Sur un
  // écran large en revanche, deux tuiles côte à côte remplissent déjà bien
  // l'espace : la grille y reste meilleure.
  const isPortrait = gridSize.height > 0 && gridSize.height > gridSize.width;
  const localTile = tiles.find((t) => t.isLocal) || null;
  const remoteTile = tiles.find((t) => !t.isLocal) || null;
  const duoMode = isPortrait && tiles.length === 2 && !!localTile && !!remoteTile;

  const duoMain = duoSwapped ? localTile : remoteTile;
  const duoPip = duoSwapped ? remoteTile : localTile;

  // ---- Mode grille égalitaire ----
  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 sm:p-5">
      <div ref={gridRef} className="flex-1 min-h-0 flex items-center justify-center">
        {duoMode ? (
          <div className="relative w-full h-full">
            <VideoCard
              variant="grid"
              participant={duoMain.participant}
              stream={duoMain.stream}
              isLocal={duoMain.isLocal}
              videoEnabled={duoMain.videoEnabled}
              micEnabled={duoMain.micEnabled}
              handRaised={duoMain.handRaised}
              isScreenShare={duoMain.isScreenShare}
              audioOutputId={audioOutputId}
            />

            {/* Vignette flottante, comme dans toutes les applications d'appel.
                Un appui permute les deux vues : c'est le seul geste attendu ici,
                et il évite d'avoir à la déplacer. */}
            <button
              onClick={() => setDuoSwapped((swapped) => !swapped)}
              aria-label="Permuter les vues"
              title="Permuter les vues"
              className="absolute bottom-3 right-3 z-30 w-[30%] max-w-[132px] aspect-[3/4] rounded-lg overflow-hidden shadow-overlay ring-2 ring-white/70"
            >
              <VideoCard
                variant="grid"
                participant={duoPip.participant}
                stream={duoPip.stream}
                isLocal={duoPip.isLocal}
                videoEnabled={duoPip.videoEnabled}
                micEnabled={duoPip.micEnabled}
                handRaised={duoPip.handRaised}
                isScreenShare={duoPip.isScreenShare}
                audioOutputId={audioOutputId}
              />
            </button>
          </div>
        ) : (
        <>
        {/* Repli en grille CSS tant que le conteneur n'est pas mesuré (premier
            rendu, ou navigateur sans ResizeObserver). Sans lui, un échec de
            mesure ne donnerait aucune tuile — donc ni image ni son, puisque
            les balises <audio> vivent dans les tuiles. */}
        <div
          className={layout ? 'grid' : 'grid w-full max-h-full overflow-y-auto scrollbar-hide'}
          style={
            layout
              ? {
                  gridTemplateColumns: `repeat(${layout.cols}, ${layout.tileWidth}px)`,
                  gap: `${TILE_GAP}px`,
                }
              : {
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: `${TILE_GAP}px`,
                }
          }
        >
          {tiles.map((tile) => (
            <div
              key={tile.tileId}
              className={layout ? undefined : 'aspect-video'}
              style={layout ? { width: layout.tileWidth, height: layout.tileHeight } : undefined}
            >
              <TileWithPin
                tile={tile}
                variant="grid"
                isPinned={false}
                // En dessous de trois tuiles, epingler ne sert a rien : il n'y a
                // personne d'autre a regarder. La punaise, desormais visible en
                // permanence au doigt, ne serait que du bruit sur l'image.
                showPin={tiles.length > 2}
                audioOutputId={audioOutputId}
                onTogglePin={() => togglePin(tile.tileId)}
              />
            </div>
          ))}
        </div>
        </>
        )}
      </div>

      {tiles.length === 1 && (
        <div className="flex-none pt-3 text-center">
          <p className="text-slate-700 text-sm font-medium">En attente d&apos;autres participants…</p>
          <p className="text-slate-500 text-xs mt-1">Partagez le code ou le lien de la réunion.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Une tuile et son bouton d'épinglage. Le bouton vit ici plutôt que dans
 * VideoCard : celui-ci se contente d'afficher un participant, la disposition
 * et les interactions qui la modifient restent l'affaire de VideoGrid.
 */
function TileWithPin({ tile, variant, isPinned, isSpotlighted = false, showPin = true, audioOutputId, onTogglePin }) {
  return (
    // La vignette se dimensionne d'elle-même (largeur fixe + format) ; la
    // tuile de grille, elle, remplit la boîte calculée par le parent.
    <div className={`relative group ${variant === 'tile' ? 'flex-none' : 'w-full h-full'}`}>
      <VideoCard
        variant={variant}
        participant={tile.participant}
        stream={tile.stream}
        isLocal={tile.isLocal}
        videoEnabled={tile.videoEnabled}
        micEnabled={tile.micEnabled}
        handRaised={tile.handRaised}
        isScreenShare={tile.isScreenShare}
        isActiveSpeaker={isSpotlighted}
        audioOutputId={audioOutputId}
      />

      {showPin && (
      <button
        onClick={onTogglePin}
        title={isPinned ? 'Détacher' : 'Épingler en grand'}
        // Haut-centre : les quatre coins sont déjà pris (HÔTE, main levée,
        // micro coupé) et se chevaucheraient.
        aria-label={isPinned ? 'Détacher' : 'Épingler en grand'}
        // Visible en permanence la ou il n'y a pas de survol : au doigt,
        // `group-hover` ne se declenche jamais, l'epinglage etait donc
        // inaccessible sur telephone.
        className={`absolute top-1.5 left-1/2 -translate-x-1/2 z-40 w-8 h-8 sm:w-7 sm:h-7 rounded-md flex items-center justify-center transition-all ${
          isPinned
            ? 'bg-brand-500 text-white opacity-100'
            : 'bg-black/55 text-white opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus:opacity-100 hover:bg-black/75'
        }`}
      >
        {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
      </button>
      )}
    </div>
  );
}
