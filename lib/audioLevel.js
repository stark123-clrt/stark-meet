/**
 * Détection « parle en ce moment », mutualisée pour toute la page.
 *
 * Chaque tuile créait auparavant son propre `AudioContext` et sa propre boucle
 * `requestAnimationFrame`. Trois problèmes :
 *
 *  - Safari plafonne le nombre de contextes audio par page (quatre en
 *    pratique). Au-delà, la création lève, l'erreur était avalée par un
 *    `try/catch`, et les indicateurs de niveau s'éteignaient silencieusement
 *    pour tout le monde à partir du cinquième participant.
 *  - Sur iOS, un contexte créé hors geste utilisateur démarre `suspended` : les
 *    relevés restaient à zéro, l'indicateur ne s'allumait jamais.
 *  - N boucles à 60 Hz pour animer quatre barres, c'est un téléphone qui
 *    chauffe dès quelques participants.
 *
 * Ici : un contexte unique, un analyseur par flux, une seule boucle qui relève
 * tout le monde à cadence réduite. Un même flux affiché deux fois (scène + son
 * vignette) ne coûte qu'un seul analyseur.
 */

// ~15 relevés par seconde. L'œil ne distingue pas cette cadence de 60 sur des
// barres d'égaliseur, et c'est quatre fois moins de travail.
const SAMPLE_INTERVAL_MS = 66;
const SPEAKING_THRESHOLD = 25;

let context = null;
let resumeArmed = false;
let loopHandle = null;
let lastSampleAt = 0;

/** stream -> { source, analyser, data, trackId, listeners:Set, speaking } */
const entries = new Map();

const GESTURES = ['pointerdown', 'touchend', 'keydown'];

/**
 * Reprendre le contexte au premier geste de l'utilisateur. Les navigateurs
 * n'autorisent `resume()` que dans un gestionnaire d'événement d'interaction ;
 * l'écouteur se retire de lui-même dès que le contexte tourne.
 */
function armResume() {
  if (resumeArmed || typeof document === 'undefined') return;
  resumeArmed = true;

  const wake = () => {
    context?.resume().catch(() => {});
    if (context?.state === 'running') {
      GESTURES.forEach((event) => document.removeEventListener(event, wake));
      resumeArmed = false;
    }
  };

  GESTURES.forEach((event) => document.addEventListener(event, wake, { passive: true }));
}

function getContext() {
  if (context) {
    // Le contexte peut retomber en pause (onglet mis en veille par le système,
    // interruption d'appel sur mobile) : on le relance à chaque abonnement.
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
      armResume();
    }
    return context;
  }

  if (typeof window === 'undefined') return null;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  try {
    context = new AudioContextCtor();
  } catch (err) {
    console.warn('Contexte audio indisponible, indicateurs de niveau désactivés:', err);
    return null;
  }

  if (context.state === 'suspended') {
    context.resume().catch(() => {});
    armResume();
  }
  return context;
}

function releaseEntry(stream) {
  const entry = entries.get(stream);
  if (!entry) return;
  try {
    entry.source.disconnect();
    entry.analyser.disconnect();
  } catch {
    // Nœud déjà détaché — rien à faire.
  }
  entries.delete(stream);
}

function tick(now) {
  loopHandle = requestAnimationFrame(tick);
  if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
  lastSampleAt = now;

  for (const entry of entries.values()) {
    entry.analyser.getByteFrequencyData(entry.data);

    let total = 0;
    for (let i = 0; i < entry.data.length; i += 1) total += entry.data[i];
    const speaking = total / entry.data.length > SPEAKING_THRESHOLD;

    // On ne prévient que sur changement d'état : sans ça, chaque tuile
    // rendrait à nouveau quinze fois par seconde pour rien.
    if (speaking !== entry.speaking) {
      entry.speaking = speaking;
      entry.listeners.forEach((listener) => listener(speaking));
    }
  }
}

function startLoop() {
  if (loopHandle == null) loopHandle = requestAnimationFrame(tick);
}

function stopLoop() {
  if (loopHandle != null) cancelAnimationFrame(loopHandle);
  loopHandle = null;
  lastSampleAt = 0;
}

/**
 * S'abonner au niveau audio d'un flux.
 *
 * @param {MediaStream} stream
 * @param {(speaking: boolean) => void} onSpeakingChange
 * @returns {() => void} désabonnement
 */
export function subscribeToAudioLevel(stream, onSpeakingChange) {
  const audioTrack = stream?.getAudioTracks()[0];
  if (!audioTrack) return () => {};

  const audioContext = getContext();
  if (!audioContext) return () => {};

  let entry = entries.get(stream);

  // Couper puis rallumer son micro remplace la piste À L'INTÉRIEUR du même
  // objet MediaStream : le nœud source, lui, resterait branché sur l'ancienne.
  if (entry && entry.trackId !== audioTrack.id) {
    releaseEntry(stream);
    entry = null;
  }

  if (!entry) {
    try {
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      entry = {
        source,
        analyser,
        trackId: audioTrack.id,
        data: new Uint8Array(analyser.frequencyBinCount),
        listeners: new Set(),
        speaking: false,
      };
      entries.set(stream, entry);
    } catch (err) {
      console.warn('Analyse du niveau audio impossible pour ce flux:', err);
      return () => {};
    }
  }

  entry.listeners.add(onSpeakingChange);
  onSpeakingChange(entry.speaking);
  startLoop();

  const current = entry;
  return () => {
    current.listeners.delete(onSpeakingChange);
    if (current.listeners.size === 0) releaseEntry(stream);
    if (entries.size === 0) stopLoop();
  };
}
