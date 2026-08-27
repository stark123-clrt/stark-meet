'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Camera, Mic, Volume2, Info } from 'lucide-react';

/**
 * Choix des périphériques : caméra, microphone, sortie audio.
 *
 * Le sélecteur applique réellement les changements au flux en cours, via le
 * hook média. La version précédente ouvrait un flux de test puis l'arrêtait
 * aussitôt : le choix n'atteignait ni le flux local ni le producer, changer de
 * micro n'avait donc strictement aucun effet.
 *
 * Il ne demande pas non plus l'accès aux périphériques à l'ouverture — on est
 * déjà en réunion, l'autorisation est acquise, et un second `getUserMedia`
 * pouvait échouer en `NotReadableError` sur une caméra déjà occupée.
 */

// La sortie audio ne se choisit que sur Chromium. Ailleurs, elle suit le
// réglage système et la section n'a pas lieu d'être affichée.
function supportsAudioOutput() {
  return (
    typeof window !== 'undefined' &&
    typeof window.HTMLMediaElement !== 'undefined' &&
    typeof window.HTMLMediaElement.prototype.setSinkId === 'function'
  );
}

function DeviceField({ icon: Icon, label, devices, value, onChange, emptyLabel, fallbackName }) {
  return (
    <div className="space-y-2.5">
      <label className="flex items-center gap-2 text-slate-950 text-sm font-medium">
        <Icon className="h-4 w-4 text-brand-500" />
        {label}
      </label>
      <select
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={devices.length === 0}
        className="w-full px-3.5 py-2.5 bg-surface border border-slate-200 rounded-md text-slate-950 text-sm focus:outline-none focus:border-brand-500 transition-colors disabled:opacity-60"
      >
        {devices.length === 0 ? (
          <option value="">{emptyLabel}</option>
        ) : (
          devices.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `${fallbackName} ${index + 1}`}
            </option>
          ))
        )}
      </select>
    </div>
  );
}

export default function DeviceSelector({
  onClose,
  audioInputId,
  videoInputId,
  audioOutputId,
  onSelectAudioInput,
  onSelectVideoInput,
  onSelectAudioOutput,
}) {
  const [videoDevices, setVideoDevices] = useState([]);
  const [audioDevices, setAudioDevices] = useState([]);
  const [outputDevices, setOutputDevices] = useState([]);

  const [selectedVideoId, setSelectedVideoId] = useState(videoInputId || '');
  const [selectedAudioId, setSelectedAudioId] = useState(audioInputId || '');
  const [selectedOutputId, setSelectedOutputId] = useState(audioOutputId || '');

  const [isLoading, setIsLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState('');

  const canChooseOutput = supportsAudioOutput();

  const loadDevices = useCallback(async () => {
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();

      // Les libellés ne sont exposés qu'une fois l'autorisation accordée. Si
      // tout est vide, c'est qu'on n'a pas encore d'accès média : on le
      // demande, puis on relâche aussitôt — mais seulement dans ce cas.
      const hasLabels = devices.some((device) => device.label);
      if (!hasLabels) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((track) => track.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }

      setVideoDevices(devices.filter((d) => d.kind === 'videoinput'));
      setAudioDevices(devices.filter((d) => d.kind === 'audioinput'));
      setOutputDevices(devices.filter((d) => d.kind === 'audiooutput'));
    } catch (error) {
      console.error('Erreur lors du chargement des périphériques:', error);
      setFeedback("Impossible de lister les périphériques. Vérifiez les autorisations du navigateur.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();

    // Brancher un casque pendant la réunion doit le faire apparaître dans la
    // liste sans rouvrir la fenêtre.
    const onDeviceChange = () => loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  }, [loadDevices]);

  // Le périphérique réellement actif fait autorité sur la sélection affichée,
  // tant que l'utilisateur n'a pas touché au menu.
  useEffect(() => {
    setSelectedAudioId((current) => current || audioInputId || '');
    setSelectedVideoId((current) => current || videoInputId || '');
    setSelectedOutputId((current) => current || audioOutputId || '');
  }, [audioInputId, videoInputId, audioOutputId]);

  const hasChanges =
    (selectedAudioId && selectedAudioId !== audioInputId) ||
    (selectedVideoId && selectedVideoId !== videoInputId) ||
    (canChooseOutput && selectedOutputId && selectedOutputId !== audioOutputId);

  const applyDeviceChanges = async () => {
    setApplying(true);
    setFeedback('');

    const failures = [];

    if (selectedAudioId && selectedAudioId !== audioInputId) {
      const ok = await onSelectAudioInput?.(selectedAudioId);
      if (!ok) failures.push('le microphone');
    }

    if (selectedVideoId && selectedVideoId !== videoInputId) {
      const ok = await onSelectVideoInput?.(selectedVideoId);
      if (!ok) failures.push('la caméra');
    }

    if (canChooseOutput && selectedOutputId && selectedOutputId !== audioOutputId) {
      onSelectAudioOutput?.(selectedOutputId);
    }

    setApplying(false);

    // On ne referme pas sur un échec : le message doit rester lisible, et la
    // personne peut essayer un autre appareil sans rouvrir la fenêtre.
    if (failures.length > 0) {
      setFeedback(`Impossible de changer ${failures.join(' et ')}. Le réglage précédent reste actif.`);
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-sm">
      <div className="bg-surface rounded-lg shadow-2xl w-full max-w-md border border-slate-200">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h3 className="text-slate-950 text-base font-semibold">Paramètres des périphériques</h3>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-950 hover:bg-slate-100 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {isLoading ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-7 w-7 border-b-2 border-brand-500" />
              <p className="text-slate-500 mt-4 text-sm">Chargement des périphériques…</p>
            </div>
          ) : (
            <>
              <DeviceField
                icon={Camera}
                label="Caméra"
                devices={videoDevices}
                value={selectedVideoId}
                onChange={setSelectedVideoId}
                emptyLabel="Aucune caméra détectée"
                fallbackName="Caméra"
              />

              <DeviceField
                icon={Mic}
                label="Microphone"
                devices={audioDevices}
                value={selectedAudioId}
                onChange={setSelectedAudioId}
                emptyLabel="Aucun microphone détecté"
                fallbackName="Microphone"
              />

              {canChooseOutput && (
                <DeviceField
                  icon={Volume2}
                  label="Sortie audio"
                  devices={outputDevices}
                  value={selectedOutputId}
                  onChange={setSelectedOutputId}
                  emptyLabel="Aucune sortie détectée"
                  fallbackName="Sortie"
                />
              )}

              {feedback && (
                <p className="px-3.5 py-2.5 rounded-md bg-warning-50 border border-warning-500/25 text-[13px] text-slate-700">
                  {feedback}
                </p>
              )}

              <div className="flex items-start gap-3 p-3.5 bg-slate-100 border border-slate-200 rounded-md">
                <Info className="h-4 w-4 text-slate-700 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-slate-500 leading-relaxed">
                  {canChooseOutput
                    ? 'Les changements s’appliquent immédiatement au flux en cours, sans interrompre la réunion.'
                    : 'Les changements s’appliquent immédiatement au flux en cours. Le choix de la sortie audio n’est pas proposé par ce navigateur : elle suit le réglage du système.'}
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 p-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm text-slate-500 hover:text-slate-950 hover:bg-slate-100 transition-colors"
          >
            Annuler
          </button>
          <button
            onClick={applyDeviceChanges}
            disabled={isLoading || applying || !hasChanges}
            className="px-4 py-2 rounded-md bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applying ? 'Application…' : 'Appliquer'}
          </button>
        </div>
      </div>
    </div>
  );
}
