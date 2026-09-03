/**
 * Fork audio vers le service de transcription — architecture v2.
 *
 * Remplace `transcription-fork.js`, qui passait par un `PlainTransport` UDP,
 * un fichier SDP et un ffmpeg externe. Ici :
 *
 *   DirectTransport → consumer.on('rtp') → WebSocket binaire → service Python
 *
 * CE QUE ÇA SUPPRIME, et ce n'est pas cosmétique — chacun de ces points a causé
 * une panne en production :
 *
 *  · le pool de ports UDP, et les conflits qui allaient avec ;
 *  · le fichier SDP, et son adresse d'écoute qu'il fallait mettre à `0.0.0.0`
 *    faute de quoi ffmpeg n'entendait rien ;
 *  · l'appel à `transport.connect()`, sans lequel mediasoup n'émettait rien en
 *    silence ;
 *  · ffmpeg lui-même, qui abandonnait sur un délai réseau et laissait un
 *    participant sans transcription pour toute la réunion ;
 *  · la route publique `/internal/transcript` et son secret partagé — le texte
 *    revient maintenant par la même connexion.
 *
 * CE QUI EST CONSERVÉ : l'identité du locuteur est figée à l'ouverture, parce
 * que le texte arrive plus tard et que le transport peut avoir été réattribué.
 */

const WebSocket = require('ws');

const ENABLED = process.env.TRANSCRIPTION_ENABLED === 'true';

// Plafond de flux simultanés. Le service traite tout en parallèle, mais le CPU
// reste fini : mesuré à RTF 0,437 sur cette machine, soit environ deux
// locuteurs simultanés en régime continu.
const MAX_SESSIONS = Number(process.env.TRANSCRIPTION_MAX_SESSIONS) || 6;

// Écart de niveau au-delà duquel un flux est considéré comme un écho du flux
// dominant, et cesse d'être envoyé au moteur.
//
// ⚠️ Problème réel, constaté en production : sans casque, le micro d'un
// participant capte la voix de l'autre par ses haut-parleurs. Les deux flux
// transcrivaient alors les mêmes mots sous deux noms différents — 62 phrases
// attribuées à une personne, 1 à l'autre, alors que les deux parlaient autant.
//
// Un écho acoustique est toujours nettement plus faible que la voix directe.
// Comparer les niveaux que l'AudioLevelObserver nous donne déjà suffit donc à
// les distinguer, sans rien calculer de plus.
const GATE_MARGIN_DB = Number(process.env.TRANSCRIPTION_GATE_MARGIN_DB) || 12;

// Durée pendant laquelle un flux reste fermé après avoir été jugé dominé. Le
// détecteur ne parle que toutes les 400 ms : sans rémanence, la porte
// clignoterait entre deux mesures.
const GATE_HOLD_MS = Number(process.env.TRANSCRIPTION_GATE_HOLD_MS) || 700;

const SERVICE_PORT = Number(process.env.TRANSCRIBER_PORT) || 8077;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECTS = 5;

/**
 * Adresse du service. Il tourne en `--network host` ; mediasoup, en bridge, le
 * joint par la passerelle par défaut de son réseau Docker. On la détecte plutôt
 * que de la configurer : une IP de bridge change à chaque recréation de réseau.
 */
function detectHostGateway() {
  try {
    const fs = require('fs');
    const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const columns = line.trim().split(/\s+/);
      if (columns[1] === '00000000' && columns[2] && columns[2] !== '00000000') {
        return columns[2].match(/../g).reverse().map((hex) => parseInt(hex, 16)).join('.');
      }
    }
  } catch {
    // Hors Linux, ou /proc indisponible.
  }
  return '127.0.0.1';
}

const SERVICE_HOST = process.env.TRANSCRIBER_HOST || detectHostGateway();
const SERVICE_URL = `ws://${SERVICE_HOST}:${SERVICE_PORT}/stream`;

const sessions = new Map(); // producerId -> session
const stats = { opened: 0, failed: 0, refusedOverCap: 0, packets: 0, gated: 0, reconnects: 0 };

/**
 * Ferme les flux dominés par un autre, à partir des niveaux mesurés.
 *
 * Appelé à chaque relevé de l'AudioLevelObserver. `volumes` est déjà trié du
 * plus fort au plus faible par mediasoup, mais on ne s'appuie pas dessus.
 */
function applyGate(volumes) {
  if (!Array.isArray(volumes) || volumes.length < 2) return;

  const loudest = Math.max(...volumes.map((entry) => entry.volume));
  const until = Date.now() + GATE_HOLD_MS;

  for (const { producer, volume } of volumes) {
    if (loudest - volume < GATE_MARGIN_DB) continue;
    const session = sessions.get(producer.id);
    if (session) session.gatedUntil = until;
  }
}

/**
 * Ouvre un flux de transcription pour un producteur audio.
 *
 * `onTranscript` reçoit chaque hypothèse et chaque phrase confirmée. Volontairement
 * hors du chemin critique : aucune erreur ici ne doit interrompre la visio.
 */
async function startStream({ router, producerId, meetingId, speakerName, participantId, onTranscript }) {
  if (!ENABLED) return null;
  if (sessions.has(producerId)) return sessions.get(producerId);

  if (sessions.size >= MAX_SESSIONS) {
    stats.refusedOverCap += 1;
    console.warn(`🎙️ Plafond de ${MAX_SESSIONS} flux atteint — ${speakerName} non transcrit`);
    return null;
  }

  const session = {
    producerId, meetingId, speakerName, participantId,
    transport: null, consumer: null, socket: null,
    reconnects: 0, packets: 0, closed: false,
    gatedUntil: 0, gatedPackets: 0,
    startedAt: Date.now(),
  };

  try {
    // Aucun réseau : les paquets sont livrés directement au processus Node.
    session.transport = await router.createDirectTransport();
    session.consumer = await session.transport.consume({
      producerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    connectSocket(session, onTranscript);

    session.consumer.on('rtp', (packet) => {
      // Flux dominé par un autre : c'est presque certainement l'écho de la voix
      // de quelqu'un d'autre, et le transcrire l'attribuerait au mauvais nom.
      if (Date.now() < session.gatedUntil) {
        session.gatedPackets += 1;
        stats.gated += 1;
        return;
      }
      // `packet` est le paquet RTP complet, en-tête compris. Le service se
      // charge du dépaquetage : l'en-tête ne fait pas 12 octets en WebRTC.
      if (session.socket && session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(packet);
        session.packets += 1;
        stats.packets += 1;
      }
    });

    session.consumer.on('transportclose', () => stopStream(producerId));
    session.consumer.on('producerclose', () => stopStream(producerId));

    await session.consumer.resume();

    sessions.set(producerId, session);
    stats.opened += 1;
    console.log(`🎙️ Flux ouvert · ${speakerName} · ${SERVICE_URL}`);
    return session;
  } catch (error) {
    console.error('🎙️ Ouverture du flux impossible:', error.message);
    stats.failed += 1;
    try { session.consumer?.close(); } catch { /* déjà fermé */ }
    try { session.transport?.close(); } catch { /* déjà fermé */ }
    try { session.socket?.close(); } catch { /* déjà fermé */ }
    return null;
  }
}

/**
 * Établit la connexion au service, et la rétablit si elle tombe.
 *
 * Une coupure ne doit pas condamner le locuteur au silence pour le reste de la
 * réunion — c'est exactement ce qui arrivait avec ffmpeg avant qu'on ne le
 * surveille.
 */
function connectSocket(session, onTranscript) {
  const socket = new WebSocket(SERVICE_URL);
  session.socket = socket;

  socket.on('open', () => {
    socket.send(JSON.stringify({
      meetingId: session.meetingId,
      producerId: session.producerId,
      participantId: session.participantId,
      displayName: session.speakerName,
    }));
  });

  socket.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      // L'identité vient d'ici, pas du service : elle a été figée à l'ouverture
      // et ne doit pas dépendre de ce que le service renvoie.
      onTranscript?.({
        ...payload,
        meetingId: session.meetingId,
        participantId: session.participantId,
        displayName: session.speakerName,
      });
    } catch (error) {
      console.error('🎙️ Réponse illisible du transcripteur:', error.message);
    }
  });

  socket.on('close', () => {
    if (session.closed || session.reconnects >= MAX_RECONNECTS) return;
    session.reconnects += 1;
    stats.reconnects += 1;
    console.warn(`🎙️ Connexion perdue · ${session.speakerName} · reprise ${session.reconnects}/${MAX_RECONNECTS}`);
    setTimeout(() => {
      if (!session.closed) connectSocket(session, onTranscript);
    }, RECONNECT_DELAY_MS);
  });

  socket.on('error', (error) => {
    // Sans ce gestionnaire, une erreur de socket sans écouteur ferait tomber le
    // processus entier.
    console.error(`🎙️ Erreur WebSocket · ${session.speakerName}: ${error.message}`);
  });
}

/** Ferme un flux. Idempotent. */
function stopStream(producerId) {
  const session = sessions.get(producerId);
  if (!session) return;

  sessions.delete(producerId);
  session.closed = true;

  // Fermeture propre : le service produit sa dernière phrase à la déconnexion.
  try { session.socket?.close(); } catch { /* déjà fermé */ }
  try { session.consumer?.close(); } catch { /* déjà fermé */ }
  try { session.transport?.close(); } catch { /* déjà fermé */ }

  console.log(`🎙️ Flux fermé · ${session.speakerName} · ${session.packets} paquets`);
}

function stopMeetingStreams(meetingId) {
  for (const [producerId, session] of sessions.entries()) {
    if (session.meetingId === meetingId) stopStream(producerId);
  }
}

function hasStream(producerId) {
  return sessions.has(producerId);
}

function listStreams() {
  return Array.from(sessions.values()).map((session) => ({
    producerId: session.producerId,
    meetingId: session.meetingId,
    speakerName: session.speakerName,
  }));
}

function getStats() {
  return {
    enabled: ENABLED,
    engine: 'sherpa-onnx',
    serviceUrl: SERVICE_URL,
    activeStreams: sessions.size,
    maxSessions: MAX_SESSIONS,
    ...stats,
    streams: Array.from(sessions.values()).map((session) => ({
      speaker: session.speakerName,
      packets: session.packets,
      // Paquets retenus parce qu'un autre flux dominait. Un chiffre du même
      // ordre que `packets` signale un écho permanent — donc quelqu'un sans
      // casque, et non un défaut de réglage.
      gatedPackets: session.gatedPackets,
      reconnects: session.reconnects,
      seconds: Math.round((Date.now() - session.startedAt) / 1000),
      socketOpen: session.socket?.readyState === WebSocket.OPEN,
    })),
  };
}

module.exports = {
  ENABLED,
  MAX_SESSIONS,
  applyGate,
  startStream,
  stopStream,
  stopMeetingStreams,
  hasStream,
  listStreams,
  getStats,
};
