'use client';

import { useState, useEffect } from 'react';
import { X, Camera, Mic, Monitor } from 'lucide-react';

/**
 * Sélection des périphériques (caméra, micro).
 */
export default function DeviceSelector({ onClose }) {
  const [videoDevices, setVideoDevices] = useState([]);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const [selectedAudioId, setSelectedAudioId] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();

        const videoInputs = devices.filter(d => d.kind === 'videoinput');
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        setVideoDevices(videoInputs);
        setAudioDevices(audioInputs);

        const defaultVideo = videoInputs.find(d => d.deviceId === 'default') || videoInputs[0];
        const defaultAudio = audioInputs.find(d => d.deviceId === 'default') || audioInputs[0];

        if (defaultVideo) setSelectedVideoId(defaultVideo.deviceId);
        if (defaultAudio) setSelectedAudioId(defaultAudio.deviceId);

        setIsLoading(false);
      } catch (error) {
        console.error('Erreur lors du chargement des périphériques:', error);
        setIsLoading(false);
      }
    };

    loadDevices();
  }, []);

  const applyDeviceChanges = async () => {
    try {
      const constraints = {
        video: selectedVideoId ? { deviceId: { exact: selectedVideoId } } : true,
        audio: selectedAudioId ? { deviceId: { exact: selectedAudioId } } : true,
      };

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      newStream.getTracks().forEach(track => track.stop());

      onClose();
    } catch (error) {
      console.error('Erreur lors de l\'application des périphériques:', error);
      alert('Impossible d\'accéder aux périphériques sélectionnés');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-ink-900 rounded-lg shadow-2xl w-full max-w-md border border-ink-700">
        <div className="flex items-center justify-between p-4 border-b border-ink-700">
          <h3 className="text-white text-base font-semibold">Paramètres des périphériques</h3>
          <button onClick={onClose} className="p-1.5 rounded-md text-ink-500 hover:text-white hover:bg-ink-800 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {isLoading ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-7 w-7 border-b-2 border-signal-500" />
              <p className="text-ink-500 mt-4 text-sm">Chargement des périphériques…</p>
            </div>
          ) : (
            <>
              <div className="space-y-2.5">
                <label className="flex items-center gap-2 text-white text-sm font-medium">
                  <Camera className="h-4 w-4 text-signal-400" />
                  Caméra
                </label>
                <select
                  value={selectedVideoId}
                  onChange={(e) => setSelectedVideoId(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm focus:outline-none focus:border-signal-500 transition-colors"
                >
                  {videoDevices.length === 0 ? (
                    <option>Aucune caméra détectée</option>
                  ) : (
                    videoDevices.map((device, i) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Caméra ${i + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="space-y-2.5">
                <label className="flex items-center gap-2 text-white text-sm font-medium">
                  <Mic className="h-4 w-4 text-signal-400" />
                  Microphone
                </label>
                <select
                  value={selectedAudioId}
                  onChange={(e) => setSelectedAudioId(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-ink-800 border border-ink-700 rounded-md text-white text-sm focus:outline-none focus:border-signal-500 transition-colors"
                >
                  {audioDevices.length === 0 ? (
                    <option>Aucun microphone détecté</option>
                  ) : (
                    audioDevices.map((device, i) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Microphone ${i + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="flex items-start gap-3 p-3.5 bg-ink-800 border border-ink-700 rounded-md">
                <Monitor className="h-4 w-4 text-mist-300 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-ink-500 leading-relaxed">
                  Les changements s'appliquent à votre flux actuel. Si vos périphériques n'apparaissent pas, vérifiez les permissions du navigateur.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 p-4 border-t border-ink-700">
          <button onClick={onClose} className="px-4 py-2 rounded-md text-sm text-ink-500 hover:text-white hover:bg-ink-800 transition-colors">
            Annuler
          </button>
          <button
            onClick={applyDeviceChanges}
            disabled={isLoading || !selectedVideoId || !selectedAudioId}
            className="px-4 py-2 rounded-md bg-signal-500 hover:bg-signal-400 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Appliquer
          </button>
        </div>
      </div>
    </div>
  );
}
