'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Hand, Maximize2, Minimize2 } from 'lucide-react';
import { initialsOf } from '@/lib/identity';

/**
 * Indicateur de niveau audio — les barres d'égaliseur du template.
 *
 * Remplace l'anneau vert qui entourait la tuile : celui-ci changeait la
 * bordure de toute la vignette à chaque « oui » ou toux, ce qui faisait
 * clignoter la grille entière. Une pastille discrète transmet la même
 * information sans agiter la mise en page.
 */
function AudioBars({ active }) {
  return (
    <span className="flex items-end gap-[2px] h-3.5" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          className={`w-[2.5px] rounded-full bg-current ${active ? 'animate-audio-bar' : ''}`}
          style={{
            height: active ? '100%' : '35%',
            animationDelay: `${index * 110}ms`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * VideoCard — tuile d'un participant (bandeau de vignettes ou scène
 * principale). Purement affichage : les contrôles micro/caméra vivent dans
 * la barre du bas, pas sur la tuile elle-même (fidèle au design).
 */
export default function VideoCard({
  participant,
  stream,
  isLocal = false,
  variant = 'tile', // 'tile' | 'stage'
  videoEnabled = true,
  micEnabled = true,
  isActiveSpeaker = false,
  handRaised = false,
  isScreenShare = false,
  playAudio = true,
  onSelect,
}) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [isVideoActive, setIsVideoActive] = useState(false);
  const [isAudioActive, setIsAudioActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioContextRef = useRef(null);

  // Un écran partagé doit être lisible dans son intégralité : le recadrage en
  // `cover`, correct pour un visage, ampute les bords d'un bureau — le plus
  // souvent là où se trouve justement ce qu'on veut montrer. On affiche donc
  // en `contain` par défaut, et on laisse la personne remplir la vue si elle
  // préfère zoomer sur le contenu.
  const [fillScreenShare, setFillScreenShare] = useState(false);
  const useContain = isScreenShare && !fillScreenShare;

  // Identité de la piste vidéo réellement affichée. Couper puis rallumer sa
  // caméra, ou basculer en partage d'écran, remplace la piste à l'intérieur du
  // même objet MediaStream : son identité ne change pas, l'effet de
  // branchement ne se rejouerait donc pas. Certains navigateurs (Safari en
  // particulier) n'affichent pas une piste ajoutée après coup à un flux déjà
  // attaché — d'où ce marqueur, qui déclenche un rebranchement quand la piste
  // change vraiment, et seulement dans ce cas.
  const videoTrackId = stream?.getVideoTracks()[0]?.id || null;

  // ---- Branchement du flux sur les balises média ----
  // Cet effet ne dépend QUE du flux lui-même. Il incluait auparavant
  // `videoEnabled` et `micEnabled` : couper son micro rejouait donc tout
  // l'effet, dont le nettoyage remet `srcObject` à null — la vidéo était
  // réellement débranchée puis rebranchée, d'où un clignotement de l'image à
  // chaque clic sur le micro.
  useEffect(() => {
    if (!stream) return;

    const videoElement = videoRef.current;
    const audioElement = audioRef.current;

    if (videoElement && stream.getVideoTracks().length > 0) {
      videoElement.srcObject = stream;
      const playVideo = async () => {
        try {
          await videoElement.play();
        } catch (e) {
          if (e.name !== 'AbortError') {
            setTimeout(() => {
              if (videoElement && videoElement.srcObject) videoElement.play().catch(() => {});
            }, 500);
          }
        }
      };
      playVideo();
    }

    if (!isLocal && playAudio && audioElement && stream.getAudioTracks().length > 0) {
      audioElement.srcObject = stream;
    }

    return () => {
      if (videoElement) videoElement.srcObject = null;
      if (audioElement) audioElement.srcObject = null;
    };
  }, [stream, isLocal, playAudio, videoTrackId]);

  // ---- Lecture de l'état des pistes ----
  // Purement calculatoire : ne touche à aucune balise média, peut donc se
  // rejouer aussi souvent que nécessaire sans interrompre la lecture.
  useEffect(() => {
    if (!stream) {
      setIsVideoActive(false);
      setIsAudioActive(false);
      return;
    }

    const updateTrackStates = () => {
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();

      if (isLocal) {
        setIsVideoActive(videoEnabled);
        setIsAudioActive(micEnabled);
      } else {
        // Un flux distant coupé reste une piste `live` (le SFU met le producer
        // en pause, il ne le ferme pas) : l'état annoncé par le serveur fait
        // donc autorité, la piste ne sert qu'à confirmer qu'il y a du média.
        setIsVideoActive(videoEnabled && videoTracks.length > 0 && videoTracks[0].readyState === 'live');
        setIsAudioActive(micEnabled && audioTracks.length > 0 && audioTracks[0].readyState === 'live');
      }
    };

    updateTrackStates();

    stream.addEventListener('addtrack', updateTrackStates);
    stream.addEventListener('removetrack', updateTrackStates);

    let interval;
    if (!isLocal) interval = setInterval(updateTrackStates, 500);

    return () => {
      stream.removeEventListener('addtrack', updateTrackStates);
      stream.removeEventListener('removetrack', updateTrackStates);
      if (interval) clearInterval(interval);
    };
  }, [stream, isLocal, videoEnabled, micEnabled]);

  useEffect(() => {
    // Volontairement non conditionné à `playAudio` : l'analyseur ne produit
    // aucun son, il ne fait que mesurer. Le désactiver sur la grande vue lui
    // ferait perdre son anneau d'intervenant actif.
    if (!stream || !isAudioActive) {
      setIsSpeaking(false);
      return;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let animationFrame;
      const checkAudioLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        setIsSpeaking(average > 25);
        animationFrame = requestAnimationFrame(checkAudioLevel);
      };
      checkAudioLevel();

      return () => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        if (audioContext.state !== 'closed') audioContext.close();
      };
    } catch (error) {
      console.error('Erreur détection audio:', error);
    }
  }, [stream, isAudioActive]);

  const isStage = variant === 'stage';
  // 'grid' occupe tout son conteneur (dimensionné au pixel par VideoGrid),
  // mais garde les habillages compacts d'une vignette : le bandeau
  // « INTERVENANT ACTIF » n'a de sens que sur une mise en avant unique.
  const fillsContainer = isStage || variant === 'grid';
  const initials = initialsOf(participant?.name);
  const isHost = participant?.role === 'host';
  const shortName = (participant?.name || 'Participant').replace(' (vous)', ' · vous');

  return (
    <div
      onClick={onSelect}
      // Fond plat et sombre, comme le template. Les tuiles portaient des
      // dégradés colorés assignés par hachage du nom, héritage de l'ancien
      // design : ils entraient en concurrence avec l'image vidéo et faisaient
      // tache dans une interface claire.
      className={`relative overflow-hidden bg-stage ${
        fillsContainer
          ? 'w-full h-full rounded-xl'
          : 'flex-none w-[104px] sm:w-[148px] lg:w-[176px] aspect-[16/10] rounded-lg cursor-pointer'
      }`}
      style={{
        outline: !isStage
          ? `2px solid ${isActiveSpeaker ? '#1A6DFF' : 'rgba(255,255,255,0.10)'}`
          : undefined,
        outlineOffset: !isStage ? '-2px' : undefined,
      }}
    >
      {/* Main levée — visible directement sur la tuile, comme sur Zoom ou
          Teams, pour la repérer sans ouvrir la liste des participants. */}
      {handRaised && (
        <>
          <div className="absolute inset-0 z-30 pointer-events-none rounded-[inherit] border-2 border-warning-500" />
          {!isStage && (
            <span
              className="absolute z-30 top-1.5 right-1.5 w-6 h-6 rounded-full bg-warning-500 text-white flex items-center justify-center animate-pulse"
              title="A levé la main"
            >
              <Hand className="h-3.5 w-3.5" />
            </span>
          )}
        </>
      )}

      <div className="absolute inset-0 w-full h-full flex items-center justify-center z-0">
        <span
          className={`rounded-full bg-white/10 flex items-center justify-center font-mono font-bold text-white/90 ${
            isStage ? 'w-24 h-24 sm:w-32 sm:h-32 text-3xl sm:text-4xl' : 'w-10 h-10 sm:w-11 sm:h-11 text-sm'
          }`}
        >
          {initials}
        </span>
      </div>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={`absolute inset-0 w-full h-full z-10 transition-opacity duration-300 ${
          useContain ? 'object-contain' : 'object-cover'
        } ${isVideoActive ? 'opacity-100' : 'opacity-0'} ${
          // Le miroir n'a de sens que pour sa propre caméra : appliqué à un
          // partage d'écran, il rendait tout le texte illisible à l'envers.
          isLocal && !isScreenShare ? 'scale-x-[-1]' : ''
        }`}
      />

      {isScreenShare && isStage && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            setFillScreenShare((fill) => !fill);
          }}
          title={fillScreenShare ? "Afficher l'écran en entier" : 'Remplir la vue (zoom)'}
          className="absolute top-3 right-3 z-30 w-8 h-8 rounded-md bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors"
        >
          {fillScreenShare ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      )}

      {!isLocal && playAudio && <audio ref={audioRef} autoPlay playsInline className="hidden" />}

      {isStage ? (
        <>
          {/* Pas de bandeau « intervenant actif » ici : la grande vue ne
              s'affiche que pour un partage d'écran ou un épinglage, et VideoGrid
              l'annonce déjà au-dessus. L'y répéter serait faux la plupart du
              temps — la personne mise en avant n'est pas celle qui parle.
              Le template place à cet endroit un chronomètre d'enregistrement,
              qui promettrait une capture inexistante. */}
          <div className="absolute inset-x-0 bottom-0 h-20 sm:h-[90px] z-10 pointer-events-none bg-gradient-to-t from-black/60 to-transparent" />

          {/* Niveau audio, en bas à droite comme dans le template. */}
          <span
            className={`absolute right-3 bottom-3 sm:right-5 sm:bottom-[18px] z-20 w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
              isSpeaking ? 'bg-brand-500 text-white' : 'bg-black/45 text-white/60'
            }`}
            title={isSpeaking ? 'Parle en ce moment' : 'Niveau audio'}
          >
            <AudioBars active={isSpeaking} />
          </span>
          <div className="absolute left-3 bottom-2.5 sm:left-5 sm:bottom-[18px] z-20 flex items-center gap-2.5">
            <span className="text-sm sm:text-base font-semibold text-white drop-shadow">{participant?.name || 'Participant'}</span>
            {isHost && (
              <span className="font-mono text-[9px] font-bold tracking-overline uppercase text-white bg-brand-500 rounded-xs px-1.5 py-0.5">Hôte</span>
            )}
            {!isAudioActive && (
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-error-500/25">
                <MicOff className="h-3 w-3 text-error-500" />
              </span>
            )}
            {handRaised && (
              <span
                className="flex items-center gap-1.5 h-6 px-2 rounded-full bg-warning-500 text-white font-mono text-[10px] font-bold animate-pulse"
                title="A levé la main"
              >
                <Hand className="h-3.5 w-3.5" />
                MAIN LEVÉE
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Étiquette du nom en pastille sombre, comme dans le template. */}
          <span className="absolute left-2 bottom-2 max-w-[calc(100%-52px)] z-20 px-2.5 py-1 rounded-full bg-black/55 text-[11px] sm:text-[11.5px] font-medium text-white truncate">
            {shortName}
          </span>
          {isHost && (
            <span className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 z-20 font-mono text-[8.5px] sm:text-[9px] font-bold tracking-overline uppercase text-white bg-brand-500 rounded-xs px-1.5 py-0.5">
              Hôte
            </span>
          )}
          {/* Pastille micro affichée en permanence — bleue si ouvert, rouge si
              coupé. N'apparaître qu'en cas de coupure laissait planer un doute :
              on ne savait pas si l'information était absente ou le micro ouvert.
              Quand la personne parle, la pastille affiche le niveau audio à la
              place de l'icône — c'est ce qui remplace l'anneau vert, sans faire
              bouger la bordure de toute la vignette. */}
          <span
            className={`absolute right-2 bottom-2 z-20 w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
              !isAudioActive
                ? 'bg-error-500 text-white'
                : isSpeaking
                  ? 'bg-brand-500 text-white ring-2 ring-brand-500/35'
                  : 'bg-brand-500 text-white'
            }`}
            title={!isAudioActive ? 'Micro coupé' : isSpeaking ? 'Parle en ce moment' : 'Micro ouvert'}
          >
            {!isAudioActive ? (
              <MicOff className="h-3 w-3" />
            ) : isSpeaking ? (
              <AudioBars active />
            ) : (
              <Mic className="h-3 w-3" />
            )}
          </span>
        </>
      )}
    </div>
  );
}
