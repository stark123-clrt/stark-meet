'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video as VideoIcon, VideoOff } from 'lucide-react';

/**
 * VideoCard - Affiche la vidéo d'un participant.
 * Chaque carte gère son propre état (tracks, détection de parole)
 * indépendamment des autres.
 */
export default function VideoCard({
  participant,
  stream,
  isLocal = false,
  micEnabled = true,
  videoEnabled = true,
  onToggleMic,
  onToggleVideo
}) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [isVideoActive, setIsVideoActive] = useState(false);
  const [isAudioActive, setIsAudioActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioContextRef = useRef(null);

  const getInitials = (name) => {
    if (!name) return '?';
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

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
              if (videoElement && videoElement.srcObject) {
                videoElement.play().catch(() => {});
              }
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
    if (!isLocal) {
      interval = setInterval(updateTrackStates, 500);
    }

    return () => {
      stream.removeEventListener('addtrack', updateTrackStates);
      stream.removeEventListener('removetrack', updateTrackStates);
      if (interval) clearInterval(interval);
      if (videoRef.current) videoRef.current.srcObject = null;
      if (audioRef.current) audioRef.current.srcObject = null;
    };
  }, [stream, isLocal, videoEnabled, micEnabled]);

  // Détection de parole (pastille visuelle quand le participant parle)
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

  const initials = getInitials(participant?.name);

  return (
    <div className="relative w-full h-full bg-ink-900 overflow-hidden rounded-lg border border-ink-700">
      {isSpeaking && (
        <div className="absolute inset-0 z-30 pointer-events-none rounded-lg">
          <div className="absolute inset-0 rounded-lg border-2 border-ok-500 shadow-[0_0_24px_rgba(61,220,138,0.35)]" />
        </div>
      )}

      <div className="absolute inset-0 w-full h-full flex items-center justify-center bg-ink-850 z-0">
        <div className="text-center relative z-10">
          {!isVideoActive ? (
            <div className="relative">
              <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-ink-700 flex items-center justify-center mx-auto border border-ink-600">
                <span className="font-mono text-white text-2xl sm:text-3xl font-bold tracking-wide">
                  {initials}
                </span>
              </div>
            </div>
          ) : (
            <>
              <p className="text-white text-lg font-medium px-4 drop-shadow-md">
                {participant?.name || 'Participant'}
              </p>
              {participant?.role && (
                <p className="text-white/70 text-sm mt-2 font-mono uppercase tracking-wide">
                  {participant.role === 'host' ? 'Hôte' : participant.role === 'co-host' ? 'Co-hôte' : 'Invité'}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={`absolute inset-0 w-full h-full object-cover z-10 transition-opacity duration-300 ${
          isVideoActive ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {!isLocal && <audio ref={audioRef} autoPlay playsInline className="hidden" />}

      {participant?.role === 'host' && (
        <div className="absolute top-2.5 left-2.5 z-20 font-mono text-[10px] tracking-wide bg-signal-500/90 text-white px-2 py-0.5 rounded">
          HÔTE
        </div>
      )}

      <div className="absolute bottom-2.5 left-2.5 z-20 text-xs font-medium text-white bg-black/45 px-2 py-1 rounded flex items-center gap-1.5">
        {participant?.name || 'Participant'}
      </div>

      <div className="absolute top-2.5 right-2.5 flex gap-2 z-20">
        {isLocal ? (
          <>
            <button
              onClick={onToggleMic}
              className={`p-2 rounded-full transition-colors shadow-lg ${
                isAudioActive ? 'bg-white/15 hover:bg-white/25' : 'bg-signal-500 hover:bg-signal-400'
              }`}
              title={isAudioActive ? 'Couper le micro' : 'Activer le micro'}
            >
              {isAudioActive ? <Mic className="h-3.5 w-3.5 text-white" /> : <MicOff className="h-3.5 w-3.5 text-white" />}
            </button>
            <button
              onClick={onToggleVideo}
              className={`p-2 rounded-full transition-colors shadow-lg ${
                isVideoActive ? 'bg-white/15 hover:bg-white/25' : 'bg-signal-500 hover:bg-signal-400'
              }`}
              title={isVideoActive ? 'Couper la caméra' : 'Activer la caméra'}
            >
              {isVideoActive ? <VideoIcon className="h-3.5 w-3.5 text-white" /> : <VideoOff className="h-3.5 w-3.5 text-white" />}
            </button>
          </>
        ) : (
          !isAudioActive && (
            <div className="p-2 rounded-full bg-signal-500/90 shadow-lg" title="Micro désactivé">
              <MicOff className="h-3.5 w-3.5 text-white" />
            </div>
          )
        )}
      </div>
    </div>
  );
}
