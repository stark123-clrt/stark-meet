/**
 * JALON 1 — Fork RTP audio vers un fichier .wav
 *
 * Détourne l'audio d'un producer mediasoup vers ffmpeg, qui écrit un fichier
 * audible. Aucune transcription ici : ce jalon existe pour valider le maillon
 * qui casse le plus souvent — SDP mal formé, ports RTP, négociation du codec
 * Opus. Une fois qu'il tient, le reste de la chaîne se branche dessus.
 *
 * Trois principes tenus depuis le cahier des charges :
 *
 *  1. DÉCOUPLAGE. Aucune erreur d'ici ne doit interrompre la visio. Tout est
 *     encapsulé, tout échec est journalisé puis abandonné.
 *  2. PLAGE DE PORTS DÉDIÉE, distincte de celle des transports WebRTC
 *     (40000-40199) ET de celle de coturn (50000-50500) — le CDC proposait
 *     50000-50099, qui chevauchait la seconde.
 *  3. IDENTITÉ FIGÉE AU FORK. Le nom du locuteur est capturé à l'ouverture et
 *     transporté avec le flux. Whisper rendra son texte plusieurs secondes plus
 *     tard, quand le transport aura peut-être été recyclé vers quelqu'un
 *     d'autre : relire l'état courant attribuerait la parole au mauvais
 *     participant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ENABLED = process.env.TRANSCRIPTION_FORK_ENABLED === 'true';

// DEUX plages distinctes, et c'est nécessaire : un fork met en jeu deux ports.
//
//  · celui où **ffmpeg écoute** — la destination du RTP, écrite dans le SDP ;
//  · celui que **mediasoup lie** pour émettre — la source.
//
// Les confondre les met en conflit : les deux processus tentent de lier le même
// port et le second échoue.
const MIN_PORT = Number(process.env.TRANSCRIPTION_MIN_PORT) || 51000;
const MAX_PORT = Number(process.env.TRANSCRIPTION_MAX_PORT) || 51099;

// Plage d'émission de mediasoup, laissée à sa gestion interne via `portRange`.
// Volontairement hors de 40000-40199 (transports WebRTC) et de 50000-50500
// (relais coturn).
const TRANSPORT_MIN_PORT = Number(process.env.TRANSCRIPTION_TRANSPORT_MIN_PORT) || 51100;
const TRANSPORT_MAX_PORT = Number(process.env.TRANSCRIPTION_TRANSPORT_MAX_PORT) || 51199;

/** Laisse à ffmpeg le temps de lier son port avant l'arrivée du premier paquet. */
const FFMPEG_BIND_DELAY_MS = 300;

const OUTPUT_DIR = process.env.TRANSCRIPTION_OUTPUT_DIR
  || path.join(os.tmpdir(), 'stark-meet-forks');

// Si ffmpeg n'a rien produit depuis ce délai alors que le producer est actif,
// le processus est considéré comme zombie : il tiendrait un port et un flux.
const WATCHDOG_MS = 10000;

// ============================================================================
// Pool de ports
// ============================================================================
// Instrumenté volontairement : une fuite de port est une panne silencieuse qui
// n'apparaît qu'après N réunions. Le compteur est le critère d'acceptation du
// jalon — il doit revenir à zéro en fin de session.

const freePorts = [];
for (let port = MIN_PORT; port <= MAX_PORT; port++) freePorts.push(port);

const stats = { allocated: 0, released: 0, forksStarted: 0, forksFailed: 0 };

function allocatePort() {
  const port = freePorts.shift();
  if (port === undefined) return null;
  stats.allocated += 1;
  return port;
}

function releasePort(port) {
  if (port === undefined || port === null) return;
  if (freePorts.includes(port)) return; // ne jamais rendre deux fois
  freePorts.push(port);
  stats.released += 1;
}

// ============================================================================
// Forks actifs
// ============================================================================

const forks = new Map(); // producerId -> fork

/**
 * Construit le SDP à partir des paramètres RTP **réels du consumer**, et non de
 * valeurs écrites à la main.
 *
 * C'est mediasoup qui choisit le payload type ; le coder en dur (111, comme le
 * suggérait le CDC) fonctionne jusqu'au jour où il en choisit un autre, et
 * ffmpeg reçoit alors des paquets qu'il ignore en silence.
 */
function buildSdp(port, rtpParameters) {
  const codec = rtpParameters.codecs[0];
  const payloadType = codec.payloadType;
  const clockRate = codec.clockRate;
  const channels = codec.channels || 2;

  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=stark-meet-fork',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/${clockRate}/${channels}`,
    `a=fmtp:${payloadType} sprop-stereo=1`,
    'a=recvonly',
    '',
  ].join('\n');
}

/**
 * Ouvre un fork pour un producer audio.
 *
 * L'ordre des opérations est délibéré : le consumer est créé **en pause** avant
 * d'écrire le SDP, car lui seul connaît le payload type retenu. Puis ffmpeg est
 * lancé — il doit écouter le port avant l'arrivée du premier paquet, sinon le
 * noyau répond « port unreachable ». La reprise du consumer vient en dernier.
 *
 * @returns {Promise<object|null>} le fork, ou null si désactivé ou en échec
 */
async function startFork({ router, producerId, meetingId, speakerName, participantId }) {
  if (!ENABLED) return null;
  if (forks.has(producerId)) return forks.get(producerId);

  const port = allocatePort();
  if (port === null) {
    console.error('🎙️ Aucun port RTP disponible — fork abandonné');
    stats.forksFailed += 1;
    return null;
  }

  let transport;
  let consumer;
  let ffmpeg;
  const sdpPath = path.join(OUTPUT_DIR, `fork-${producerId}.sdp`);
  const wavPath = path.join(
    OUTPUT_DIR,
    `${meetingId}-${(speakerName || 'inconnu').replace(/[^\w-]/g, '_')}-${Date.now()}.wav`
  );

  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // mediasoup choisit lui-même son port d'émission dans sa propre plage : le
    // port alloué plus haut est celui de ffmpeg, pas le sien.
    transport = await router.createPlainTransport({
      listenInfo: {
        protocol: 'udp',
        ip: '127.0.0.1',
        portRange: { min: TRANSPORT_MIN_PORT, max: TRANSPORT_MAX_PORT },
      },
      rtcpMux: true,
      comedia: false,
    });

    consumer = await transport.consume({
      producerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    fs.writeFileSync(sdpPath, buildSdp(port, consumer.rtpParameters));

    ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning',
      '-protocol_whitelist', 'file,rtp,udp',
      '-fflags', '+nobuffer', '-flags', 'low_delay',
      '-i', sdpPath,
      '-ar', '16000', '-ac', '1',   // 16 kHz mono : le format attendu par Whisper
      '-y', wavPath,
    ]);

    ffmpeg.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) console.log(`🎙️ ffmpeg[${producerId.slice(0, 8)}] ${line}`);
    });

    // Sans ce gestionnaire, un binaire ffmpeg absent émettrait un événement
    // 'error' sans écouteur — ce qui, sur un ChildProcess, fait tomber tout le
    // serveur. Le découplage exige que ce module ne puisse jamais interrompre
    // la visio.
    ffmpeg.on('error', (err) => {
      console.error(`🎙️ ffmpeg introuvable ou non exécutable: ${err.message}`);
      stopFork(producerId);
    });

    ffmpeg.on('exit', (code, signal) => {
      console.log(`🎙️ ffmpeg terminé (code ${code}, signal ${signal}) — ${wavPath}`);
    });

    // Laisse ffmpeg lier son port : les premiers paquets envoyés avant son
    // écoute reviendraient en « port unreachable ».
    await new Promise((resolve) => setTimeout(resolve, FFMPEG_BIND_DELAY_MS));

    // ⚠️ L'appel manquant sans lequel rien ne fonctionne. Avec `comedia: false`,
    // mediasoup n'infère pas la destination : il faut la lui donner, sinon il
    // n'émet aucun paquet — et ffmpeg attend indéfiniment un flux qui ne vient
    // pas, sans même créer son fichier de sortie.
    await transport.connect({ ip: '127.0.0.1', port });

    await consumer.resume();

    const fork = {
      producerId,
      meetingId,
      port,
      // Identité figée à cet instant — voir l'en-tête de ce fichier.
      speakerName,
      participantId,
      transport,
      consumer,
      ffmpeg,
      sdpPath,
      wavPath,
      startedAt: Date.now(),
    };

    // Un ffmpeg qui n'écrit rien alors que le flux tourne est un zombie : il
    // immobilise un port et un consumer sans produire quoi que ce soit.
    fork.watchdog = setInterval(() => {
      let size = 0;
      try {
        size = fs.statSync(wavPath).size;
      } catch { /* le fichier n'existe pas encore */ }

      // Un en-tête WAV nu fait 44 octets : au-delà, des échantillons arrivent.
      if (size > 44) {
        fork.lastGrowth = Date.now();
        return;
      }
      if (Date.now() - (fork.lastGrowth || fork.startedAt) > WATCHDOG_MS) {
        console.error(`🎙️ Aucun échantillon depuis ${WATCHDOG_MS} ms — fork ${producerId.slice(0, 8)} abandonné`);
        stopFork(producerId);
      }
    }, 2000);

    forks.set(producerId, fork);
    stats.forksStarted += 1;
    console.log(`🎙️ Fork ouvert · ${speakerName} · port ${port} · ${wavPath}`);
    return fork;
  } catch (error) {
    console.error('🎙️ Ouverture du fork impossible:', error);
    stats.forksFailed += 1;

    // Nettoyage complet : un échec partiel laisserait un port ou un processus
    // en fuite, et c'est exactement ce que ce jalon doit prouver impossible.
    try { ffmpeg?.kill('SIGKILL'); } catch { /* déjà mort */ }
    try { consumer?.close(); } catch { /* déjà fermé */ }
    try { transport?.close(); } catch { /* déjà fermé */ }
    try { fs.unlinkSync(sdpPath); } catch { /* jamais écrit */ }
    releasePort(port);
    return null;
  }
}

/** Ferme un fork et rend son port. Idempotent. */
function stopFork(producerId) {
  const fork = forks.get(producerId);
  if (!fork) return;

  forks.delete(producerId);
  clearInterval(fork.watchdog);

  // SIGTERM laisse ffmpeg finaliser l'en-tête du WAV — un SIGKILL produirait un
  // fichier tronqué, donc illisible, ce qui ferait échouer le jalon pour une
  // mauvaise raison.
  try { fork.ffmpeg?.kill('SIGTERM'); } catch { /* déjà mort */ }
  try { fork.consumer?.close(); } catch { /* déjà fermé */ }
  try { fork.transport?.close(); } catch { /* déjà fermé */ }
  try { fs.unlinkSync(fork.sdpPath); } catch { /* déjà supprimé */ }

  releasePort(fork.port);
  console.log(`🎙️ Fork fermé · ${fork.speakerName} · port ${fork.port} rendu`);
}

/** Ferme tous les forks d'une réunion (départ du dernier participant). */
function stopMeetingForks(meetingId) {
  for (const [producerId, fork] of forks.entries()) {
    if (fork.meetingId === meetingId) stopFork(producerId);
  }
}

/**
 * État du module — sert de critère d'acceptation du jalon 1 : en fin de session,
 * `activeForks` doit valoir 0 et `allocated` doit égaler `released`.
 */
function getStats() {
  return {
    enabled: ENABLED,
    activeForks: forks.size,
    portsFree: freePorts.length,
    portsTotal: MAX_PORT - MIN_PORT + 1,
    ffmpegPortRange: `${MIN_PORT}-${MAX_PORT}`,
    transportPortRange: `${TRANSPORT_MIN_PORT}-${TRANSPORT_MAX_PORT}`,
    outputDir: OUTPUT_DIR,
    ...stats,
    leaked: stats.allocated - stats.released - forks.size,
  };
}

module.exports = { ENABLED, startFork, stopFork, stopMeetingForks, getStats };
