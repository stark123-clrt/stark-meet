'use client';

import { useEffect, useRef, useState } from 'react';
import { MicOff } from 'lucide-react';

// Palette de dégradés du design (mockup Claude Design) — assignée de façon
// déterministe par participant (hash du nom) pour varier les tuiles sans
// backend, comme dans la maquette d'origine.
const TILE_GRADIENTS = [
  'linear-gradient(155deg,#3a2a52,#1a1428)',
  'linear-gradient(155deg,#1f4a45,#122120)',
  'linear-gradient(155deg,#4a2f1c,#1c1410)',
  'linear-gradient(155deg,#1c3350,#111a26)',
  'linear-gradient(155deg,#2a3a52,#141c28)',
];

function gradientFor(seed) {
  let hash = 0;
  for (let i = 0; i < (seed || '').length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return TILE_GRADIENTS[hash % TILE_GRADIENTS.length];
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
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
  onSelect,
}) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [isVideoActive, setIsVideoActive] = useState(false);
  const [isAudioActive, setIsAudioActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioContextRef = useRef(null);

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
        setIsVideoActive(videoTracks.length > 0 && videoTracks[0].readyState === 'live');
        setIsAudioActive(audioTracks.length > 0 && audioTracks[0].readyState === 'live');
      }
    };

    updateTrackStates();

    if (videoRef.current && stream.getVideoTracks().length > 0) {
      const videoElement = videoRef.current;
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

    if (!isLocal && audioRef.current && stream.getAudioTracks().length > 0) {
      audioRef.current.srcObject = stream;
    }

    stream.addEventListener('addtrack', updateTrackStates);
    stream.addEventListener('removetrack', updateTrackStates);

    let interval;
    if (!isLocal) interval = setInterval(updateTrackStates, 500);

    return () => {
      stream.removeEventListener('addtrack', updateTrackStates);
      stream.removeEventListener('removetrack', updateTrackStates);
      if (interval) clearInterval(interval);
      if (videoRef.current) videoRef.current.srcObject = null;
      if (audioRef.current) audioRef.current.srcObject = null;
    };
  }, [stream, isLocal, videoEnabled, micEnabled]);

  useEffect(() => {
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
  const initials = getInitials(participant?.name);
  const bg = gradientFor(participant?.id || participant?.name || 'x');
  const isHost = participant?.role === 'host';
  const shortName = (participant?.name || 'Participant').replace(' (vous)', ' · vous');

  return (
    <div
      onClick={onSelect}
      className={`relative overflow-hidden bg-ink-850 ${
        isStage
          ? 'w-full h-full rounded-xl'
          : 'flex-none w-[132px] sm:w-[176px] aspect-[16/10] rounded-lg cursor-pointer'
      }`}
      style={{
        background: bg,
        outline: !isStage ? `2px solid ${isActiveSpeaker ? '#35d399' : 'rgba(255,255,255,0.07)'}` : undefined,
        outlineOffset: !isStage ? '-2px' : undefined,
      }}
    >
      {isSpeaking && (
        <div className="absolute inset-0 z-30 pointer-events-none rounded-[inherit]">
          <div className="absolute inset-0 rounded-[inherit] border-2 border-ok-500 shadow-[0_0_24px_rgba(53,211,153,0.35)]" />
        </div>
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
        className={`absolute inset-0 w-full h-full object-cover z-10 transition-opacity duration-300 ${
          isVideoActive ? 'opacity-100' : 'opacity-0'
        } ${isLocal ? 'scale-x-[-1]' : ''}`}
      />

      {!isLocal && <audio ref={audioRef} autoPlay playsInline className="hidden" />}

      {isStage ? (
        <>
          <span className="absolute top-3 left-3 sm:top-4 sm:left-4 z-20 flex items-center gap-1.5 font-mono text-[10px] sm:text-[10.5px] font-semibold tracking-wide text-white bg-black/45 rounded px-2 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-ok-500 inline-block" />
            INTERVENANT ACTIF
          </span>
          <div className="absolute inset-x-0 bottom-0 h-20 sm:h-[90px] z-10 pointer-events-none bg-gradient-to-t from-black/60 to-transparent" />
          <div className="absolute left-3 bottom-2.5 sm:left-5 sm:bottom-[18px] z-20 flex items-center gap-2.5">
            <span className="text-sm sm:text-base font-semibold text-white drop-shadow">{participant?.name || 'Participant'}</span>
            {isHost && (
              <span className="font-mono text-[9px] font-bold tracking-wide text-ink-950 bg-ok-500 rounded px-1.5 py-0.5">HÔTE</span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="absolute inset-x-0 bottom-0 h-9 z-10 pointer-events-none bg-gradient-to-t from-black/60 to-transparent" />
          <span className="absolute left-2 bottom-1.5 right-7 z-20 text-[11px] sm:text-[11.5px] font-medium text-white truncate">
            {shortName}
          </span>
          {isHost && (
            <span className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 z-20 font-mono text-[8.5px] sm:text-[9px] font-bold text-ink-950 bg-ok-500 rounded px-1.5 py-0.5">
              HÔTE
            </span>
          )}
          {!isAudioActive && (
            <span className="absolute right-1.5 bottom-1.5 z-20 w-5 h-5 rounded-full bg-danger-500/20 flex items-center justify-center">
              <MicOff className="h-2.5 w-2.5 text-danger-500" />
            </span>
          )}
        </>
      )}
    </div>
  );
}
