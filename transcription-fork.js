/**
 * Fork RTP audio vers le service de transcription.
 *
 * Deux modes, choisis par `TRANSCRIPTION_MODE` :
 *
 *  · `stream` (défaut) — le RTP part vers le service Python, qui renvoie le
 *    texte à Node, qui le rediffuse sur `ctl:<meetingId>`. C'est le jalon 3.
 *  · `file` — ffmpeg local écrit un `.wav` sur disque. C'est le jalon 1,
 *    conservé parce qu'il répond à une question que le mode `stream` ne sait
 *    pas isoler : « le RTP circule-t-il du tout ? »
 *
 * TROIS PRINCIPES TENUS :
 *
 *  1. DÉCOUPLAGE. Aucune erreur d'ici ne doit interrompre la visio. Tout est
 *     encapsulé, tout échec est journalisé puis abandonné.
 *  2. PLAGES DE PORTS DÉDIÉES, distinctes des transports WebRTC (40000-40199)
 *     et du relais coturn (50000-50500).
 *  3. IDENTITÉ FIGÉE AU FORK. Le nom du locuteur est capturé à l'ouverture et
 *     transporté avec le flux : Whisper rend son texte plusieurs secondes plus
 *     tard, quand le transport aura peut-être été recyclé vers quelqu'un
 *     d'autre.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ENABLED = process.env.TRANSCRIPTION_FORK_ENABLED === 'true';
const MODE = process.env.TRANSCRIPTION_MODE || 'stream';

const MIN_PORT = Number(process.env.TRANSCRIPTION_MIN_PORT) || 51000;
const MAX_PORT = Number(process.env.TRANSCRIPTION_MAX_PORT) || 51099;
const TRANSPORT_MIN_PORT = Number(process.env.TRANSCRIPTION_TRANSPORT_MIN_PORT) || 51100;
const TRANSPORT_MAX_PORT = Number(process.env.TRANSCRIPTION_TRANSPORT_MAX_PORT) || 51199;

// Plafond de sessions simultanées, calé sur la capacité MESURÉE de la machine
// (`small` à RTF 0,399 sur 3 cœurs ≈ 2 locuteurs, 3 avec contre-pression).
// L'aligner sur les 5 du CDC ne transcrirait pas plus de monde : ça
// accumulerait du retard et ferait dériver tout le transcript.
const MAX_SESSIONS = Number(process.env.TRANSCRIPTION_MAX_SESSIONS) || 3;

const OUTPUT_DIR = process.env.TRANSCRIPTION_OUTPUT_DIR
  || path.join(os.tmpdir(), 'stark-meet-forks');

const SERVICE_PORT = Number(process.env.TRANSCRIBER_PORT) || 8000;
const FFMPEG_BIND_DELAY_MS = 300;
const WATCHDOG_MS = 10000;

/**
 * Adresse du service Python. Il tourne en `--network host`, donc mediasoup —
 * qui est en bridge — l'atteint par la passerelle par défaut de son réseau
 * Docker. On la détecte au lieu de la demander en configuration : une IP de
 * bridge change à chaque recréation de réseau.
 */
function detectHostGateway() {
  try {
    const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const columns = line.trim().split(/\s+/);
      // Destination 00000000 = route par défaut ; colonne 2 = passerelle.
      if (columns[1] === '00000000' && columns[2] && columns[2] !== '00000000') {
        const octets = columns[2].match(/../g).reverse().map((hex) => parseInt(hex, 16));
        return octets.join('.');
      }
    }
  } catch {
    // Hors Linux ou /proc indisponible.
  }
  return '127.0.0.1';
}

const SERVICE_HOST = process.env.TRANSCRIBER_HOST || detectHostGateway();
const SERVICE_URL = `http://${SERVICE_HOST}:${SERVICE_PORT}`;

// ============================================================================
// Pool de ports
// ============================================================================
// Instrumenté : une fuite de port est une panne silencieuse qui n'apparaît
// qu'après plusieurs réunions. `leaked` doit rester à zéro.

const freePorts = [];
for (let port = MIN_PORT; port <= MAX_PORT; port++) freePorts.push(port);

const stats = { allocated: 0, released: 0, forksStarted: 0, forksFailed: 0, refusedOverCap: 0 };

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

const forks = new Map(); // producerId -> fork

/**
 * SDP construit depuis les paramètres RTP **réels du consumer**. Coder le
 * payload type en dur fonctionne jusqu'au jour où mediasoup en choisit un
 * autre — et ffmpeg ignore alors les paquets en silence.
 */
function buildSdp(port, rtpParameters) {
  const codec = rtpParameters.codecs[0];
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=stark-meet-fork',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/AVP ${codec.payloadType}`,
    `a=rtpmap:${codec.payloadType} opus/${codec.clockRate}/${codec.channels || 2}`,
    `a=fmtp:${codec.payloadType} sprop-stereo=1`,
    'a=recvonly',
    '',
  ].join('\n');
}

/** Appel au service Python. Jamais bloquant pour l'appelant. */
async function callService(endpoint, body) {
  const response = await fetch(`${SERVICE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${endpoint} → HTTP ${response.status}`);
  return response.json();
}

async function startFork({ router, producerId, meetingId, speakerName, participantId }) {
  if (!ENABLED) return null;
  if (forks.has(producerId)) return forks.get(producerId);

  // Refus explicite au-delà de la capacité mesurée : mieux vaut ne pas
  // transcrire une voix que de faire dériver toutes les autres.
  if (forks.size >= MAX_SESSIONS) {
    stats.refusedOverCap += 1;
    console.warn(`🎙️ Plafond de ${MAX_SESSIONS} sessions atteint — ${speakerName} non transcrit`);
    return null;
  }

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

    // mediasoup choisit son port d'émission dans SA plage : le port alloué
    // au-dessus est celui de la destination, pas le sien. Les confondre les
    // mettrait en conflit.
    // ⚠️ L'adresse d'écoute détermine l'interface d'ÉMISSION. En mode `stream`
    // la destination est l'hôte (10.x.x.1 vu du bridge Docker) : une socket
    // liée à 127.0.0.1 ne peut pas l'atteindre, les paquets partent sur le
    // loopback et disparaissent sans la moindre erreur. En mode `file` ffmpeg
    // est dans le même conteneur, et le loopback est alors le bon choix.
    transport = await router.createPlainTransport({
      listenInfo: {
        protocol: 'udp',
        ip: MODE === 'file' ? '127.0.0.1' : '0.0.0.0',
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

    const codec = consumer.rtpParameters.codecs[0];
    let destinationIp = '127.0.0.1';

    if (MODE === 'file') {
      // Jalon 1 — ffmpeg local vers un .wav. Sert à isoler la question « le RTP
      // circule-t-il ? » sans impliquer le service Python.
      fs.writeFileSync(sdpPath, buildSdp(port, consumer.rtpParameters));

      ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'warning',
        '-protocol_whitelist', 'file,rtp,udp',
        '-fflags', '+nobuffer', '-flags', 'low_delay',
        '-i', sdpPath,
        '-ar', '16000', '-ac', '1',
        '-y', wavPath,
      ]);

      // Sans ce gestionnaire, un ffmpeg absent émettrait un 'error' sans
      // écouteur — ce qui, sur un ChildProcess, fait tomber tout le serveur.
      ffmpeg.on('error', (err) => {
        console.error(`🎙️ ffmpeg indisponible: ${err.message}`);
        stopFork(producerId);
      });
      ffmpeg.stderr.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line) console.log(`🎙️ ffmpeg ${line}`);
      });

      await new Promise((resolve) => setTimeout(resolve, FFMPEG_BIND_DELAY_MS));
    } else {
      // Jalon 3 — le service Python écoute ce port et lance son propre ffmpeg.
      await callService('/session/start', {
        meetingId,
        producerId,
        participantId,
        displayName: speakerName,
        rtpPort: port,
        payloadType: codec.payloadType,
      });
      destinationIp = SERVICE_HOST;

      // Laisser à ffmpeg le temps de se lier au port avant d'émettre. Sans cette
      // pause, les premiers paquets tombent dans le vide — et ffmpeg, qui n'a
      // encore rien reçu, peut abandonner sur son propre délai d'attente. Un
      // participant s'est ainsi retrouvé avec zéro octet reçu pendant toute une
      // réunion, alors que mediasoup l'entendait parfaitement.
      await new Promise((resolve) => setTimeout(resolve, FFMPEG_BIND_DELAY_MS));
    }

    // ⚠️ Sans `connect`, mediasoup n'infère pas la destination avec
    // `comedia: false` et n'émet aucun paquet — le récepteur attend
    // indéfiniment un flux qui ne vient jamais.
    await transport.connect({ ip: destinationIp, port });
    await consumer.resume();

    const fork = {
      producerId, meetingId, port,
      speakerName, participantId,     // identité figée
      transport, consumer, ffmpeg, sdpPath, wavPath,
      startedAt: Date.now(),
    };

    if (MODE === 'file') {
      // Un ffmpeg qui n'écrit rien alors que le flux tourne est un zombie : il
      // immobilise un port et un consumer sans rien produire.
      fork.watchdog = setInterval(() => {
        let size = 0;
        try { size = fs.statSync(wavPath).size; } catch { /* pas encore créé */ }
        if (size > 44) { fork.lastGrowth = Date.now(); return; }
        if (Date.now() - (fork.lastGrowth || fork.startedAt) > WATCHDOG_MS) {
          console.error(`🎙️ Aucun échantillon depuis ${WATCHDOG_MS} ms — fork abandonné`);
          stopFork(producerId);
        }
      }, 2000);
    }

    forks.set(producerId, fork);
    stats.forksStarted += 1;
    console.log(`🎙️ Fork ${MODE} ouvert · ${speakerName} · port ${port} → ${destinationIp}`);
    return fork;
  } catch (error) {
    console.error('🎙️ Ouverture du fork impossible:', error.message);
    stats.forksFailed += 1;

    // Nettoyage complet : un échec partiel laisserait un port ou un processus
    // en fuite, ce que le compteur `leaked` doit rendre impossible.
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

  if (MODE === 'stream') {
    callService('/session/stop', { meetingId: fork.meetingId, producerId })
      .catch((err) => console.warn('🎙️ Arrêt de session non confirmé:', err.message));
  }

  // SIGTERM plutôt que SIGKILL : ffmpeg finalise l'en-tête de son WAV. Tué
  // brutalement, le fichier serait tronqué donc illisible.
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

function hasFork(producerId) {
  return forks.has(producerId);
}

/** Vue en lecture des forks ouverts, pour le balayage des places inactives. */
function listForks() {
  return Array.from(forks.values()).map((fork) => ({
    producerId: fork.producerId,
    meetingId: fork.meetingId,
    speakerName: fork.speakerName,
  }));
}

function getStats() {
  return {
    enabled: ENABLED,
    mode: MODE,
    serviceUrl: MODE === 'stream' ? SERVICE_URL : null,
    activeForks: forks.size,
    maxSessions: MAX_SESSIONS,
    portsFree: freePorts.length,
    portsTotal: MAX_PORT - MIN_PORT + 1,
    ffmpegPortRange: `${MIN_PORT}-${MAX_PORT}`,
    transportPortRange: `${TRANSPORT_MIN_PORT}-${TRANSPORT_MAX_PORT}`,
    outputDir: OUTPUT_DIR,
    ...stats,
    leaked: stats.allocated - stats.released - forks.size,
  };
}

module.exports = {
  ENABLED,
  MODE,
  MAX_SESSIONS,
  startFork,
  stopFork,
  stopMeetingForks,
  hasFork,
  listForks,
  getStats,
};
