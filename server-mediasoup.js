/**
 * SERVEUR MEDIASOUP - SFU pour Stark Meet
 * Architecture: Selective Forwarding Unit (SFU)
 *
 * Ce serveur gère deux plans distincts :
 *
 *  1. Le plan MÉDIA (audio/vidéo WebRTC) et sa signalisation Mediasoup.
 *  2. Le plan CONTRÔLE (`control:*`) : salle d'attente, admission, exclusion,
 *     verrouillage, mute forcé, chat. Supabase reste la base de données
 *     (source de vérité persistante) mais n'est plus le canal temps réel :
 *     Supabase Realtime passe par un websocket qui n'est pas exposé sur une
 *     instance self-hosted, donc aucun événement n'arrivait aux clients et
 *     tout le monde devait rafraîchir la page à la main.
 *
 * Les deux plans sont séparés parce qu'un participant en salle d'attente doit
 * recevoir les événements de contrôle AVANT d'avoir le droit de produire du
 * média — il est donc dans `ctl:<meetingId>` sans être dans `<meetingId>`.
 *
 * À lancer avec: node server-mediasoup.js
 */

const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
// Architecture v2 : DirectTransport + WebSocket vers un transducteur causal.
// L'ancien module `transcription-fork.js` (PlainTransport UDP + ffmpeg +
// Whisper) reste dans le dépôt à titre de repli, mais n'est plus chargé.
const transcription = require('./transcription-stream');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

io.engine.on('connection_error', (err) => {
  console.error('❌ Erreur connexion Socket.io:', {
    message: err.message,
    code: err.code,
    context: err.context
  });
});

console.log('🔧 Socket.io configuré avec CORS pour:', process.env.CLIENT_URL || 'http://localhost:3000');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'mediasoup' });
});

// État des forks de transcription. `leaked` doit rester à 0 : c'est le critère
// d'acceptation du jalon 1, une fuite de port étant une panne qui n'apparaît
// qu'après plusieurs réunions.
app.get('/transcription/stats', (req, res) => {
  // Sans cet en-tête, le navigateur ressert la réponse précédente et on croit
  // lire un état actuel alors qu'on relit celui d'il y a une heure.
  res.set('Cache-Control', 'no-store');
  res.json({
    ...transcription.getStats(),
    callbackConfigured: !!process.env.TRANSCRIBER_SECRET,
    transcribedMeetings: transcripts.size,
    confirmedSegments: Array.from(transcripts.values()).reduce((sum, s) => sum + s.finals.length, 0),
    now: new Date().toISOString(),
  });
});

app.use(express.json());

// ============================================
// TRANSCRIPTION — RETOUR DU SERVICE PYTHON
// ============================================
// Le service tourne en `--network host` et ne peut donc pas joindre ce
// conteneur par son IP de bridge : il repasse par l'URL publique, à travers
// Traefik. Cette route est donc exposée sur Internet, d'où le secret partagé —
// sans lui, n'importe qui pourrait injecter du faux texte dans une réunion.
const TRANSCRIBER_SECRET = process.env.TRANSCRIBER_SECRET || '';

// Historique conservé en mémoire pour qu'un participant qui rejoint en retard,
// ou qui recharge sa page, retrouve ce qui a déjà été dit. Volontairement non
// persisté à ce jalon : la table `meeting_transcript_segments` viendra avec le
// compte-rendu, qui est le seul consommateur ayant besoin de durabilité.
const transcripts = new Map(); // meetingId -> { finals: [], partials: Map }

// 20 000 phrases, soit des dizaines d'heures de conversation. L'ancienne borne
// de 400 était trop prudente : elle se remplissait en une heure et le transcript
// semblait alors « s'arrêter », alors qu'une phrase pèse environ 200 octets —
// 20 000 tiennent dans 4 Mio. Ce plafond n'est plus qu'un garde-fou contre une
// fuite, pas une contrainte d'usage. La vraie levée de la limite viendra de la
// persistance en base, qui permettra aussi de relire une réunion passée.
const TRANSCRIPT_HISTORY_LIMIT = Number(process.env.TRANSCRIPT_HISTORY_LIMIT) || 20000;

function transcriptStore(meetingId) {
  if (!transcripts.has(meetingId)) {
    transcripts.set(meetingId, { finals: [], partials: new Map() });
  }
  return transcripts.get(meetingId);
}

/**
 * Enregistre et rediffuse un fragment de transcription.
 *
 * Point d'entrée unique : le service de transcription renvoie désormais son
 * texte par le WebSocket qui lui apporte l'audio, mais la route HTTP est
 * conservée pour un transcripteur externe éventuel. Les deux passent par ici,
 * pour que le stockage, le tri et la diffusion restent définis à un seul
 * endroit.
 */
function recordTranscript({
  meetingId, participantId, displayName, type, text, at, spokenAt, segmentId, corrected, rawText,
}) {
  if (!meetingId || !type || typeof text !== 'string') return false;

  const store = transcriptStore(meetingId);
  const segment = {
    participantId: participantId || null,
    displayName: displayName || 'Participant',
    text,
    at: at || new Date().toISOString(),
    // Identifiant stable d'une phrase. Le transcripteur publie d'abord le texte
    // brut, puis le même segment corrigé par le LLM : c'est cette clé qui permet
    // de remplacer la phrase au lieu de l'afficher deux fois.
    segmentId: segmentId || null,
    corrected: !!corrected,
    // Texte tel qu'entendu, conservé quand le LLM a corrigé. Le compte-rendu
    // pourra ainsi revenir à la source si une correction s'avère fautive.
    rawText: rawText || null,
    // Instant de PRONONCIATION, fourni par le transcripteur. Sans lui, l'ordre
    // d'affichage serait celui de l'arrivée : deux locuteurs dont les flux
    // n'avancent pas au même rythme verraient une réponse s'afficher avant sa
    // question. Repli sur l'heure courante si le transcripteur est ancien.
    spokenAt: typeof spokenAt === 'number' ? spokenAt : Date.now() / 1000,
  };

  if (type === 'final') {
    if (text.trim()) {
      // Une phrase déjà publiée est REMPLACÉE, jamais dupliquée : c'est le cas
      // du texte brut affiché immédiatement, puis corrigé par le LLM.
      const existing = segment.segmentId
        ? store.finals.findIndex((item) => item.segmentId === segment.segmentId)
        : -1;

      if (existing >= 0) {
        store.finals[existing] = segment;
      } else {
        // Inséré à sa place chronologique, pas en fin de liste. La recherche part
        // de la fin parce que le cas courant reste l'ajout en queue.
        let index = store.finals.length;
        while (index > 0 && store.finals[index - 1].spokenAt > segment.spokenAt) index -= 1;
        store.finals.splice(index, 0, segment);
        // Une réunion longue ne doit pas faire enfler la mémoire du SFU
        // indéfiniment : on garde une fenêtre glissante d'affichage.
        if (store.finals.length > TRANSCRIPT_HISTORY_LIMIT) store.finals.shift();
      }
    }
    // L'hypothèse de ce locuteur vient d'être confirmée : elle n'a plus lieu
    // d'être affichée en gris à côté du texte définitif.
    store.partials.delete(segment.participantId);
    io.to(controlRoomName(meetingId)).emit('control:transcript-final', { segment });
  } else {
    // Une seule hypothèse par locuteur : seule la plus récente a du sens.
    if (text.trim()) store.partials.set(segment.participantId, segment);
    else store.partials.delete(segment.participantId);
    io.to(controlRoomName(meetingId)).emit('control:transcript-partial', { segment });
  }

  return true;
}

// Conservée pour un transcripteur externe qui n'utiliserait pas le WebSocket.
// Exposée sur Internet (le service tournait en `--network host` et repassait par
// Traefik), d'où le secret partagé : sans lui, n'importe qui injecterait du faux
// texte dans une réunion.
app.post('/internal/transcript', (req, res) => {
  if (!TRANSCRIBER_SECRET || req.get('X-Transcriber-Secret') !== TRANSCRIBER_SECRET) {
    return res.status(403).json({ error: 'Secret invalide' });
  }
  if (!recordTranscript(req.body || {})) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }
  res.json({ ok: true });
});

// ============================================
// CONFIGURATION MEDIASOUP
// ============================================

// Un worker mediasoup est mono-thread et sature un cœur CPU : on en lance un
// par cœur et on répartit les réunions entre eux, sans quoi tout le trafic de
// la plateforme tient sur un seul cœur quelle que soit la machine.
const NUM_WORKERS = Math.max(1, Math.min(Number(process.env.MEDIASOUP_WORKERS) || os.cpus().length, 8));

// Chaque transport WebRTC réserve un port UDP et un port TCP, et un
// participant utilise deux transports (émission + réception) : compter environ
// 2 ports UDP par personne connectée, toutes réunions confondues. L'ancienne
// plage 10000-10100 plafonnait donc le serveur entier à ~50 participants,
// au-delà desquels la création de transport échouait.
//
// La plage doit rester alignée avec celle publiée par Docker (docker-compose)
// ou le pare-feu du VPS. Pour aller nettement plus haut, passer le conteneur
// mediasoup en `network_mode: host` et élargir ces bornes.
//
// ⚠️ Ces bornes doivent correspondre EXACTEMENT aux ports publiés par Docker.
// Si mediasoup peut piocher au-delà de ce qui est mappé, il attribuera parfois
// un port injoignable et la connexion échouera de façon aléatoire.
const RTC_MIN_PORT = Number(process.env.MEDIASOUP_MIN_PORT) || 40000;
const RTC_MAX_PORT = Number(process.env.MEDIASOUP_MAX_PORT) || 40199;

const mediasoupConfig = {
  worker: {
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  },
  router: {
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: { 'x-google-start-bitrate': 1000 },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
        },
      },
    ],
  },
  webRtcTransport: {
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  },
};

// ============================================
// VARIABLES GLOBALES
// ============================================

const workers = [];
let nextWorkerIndex = 0;
const rooms = new Map(); // meetingId -> { router, peers: Map<socketId, peer> }

// Plan de contrôle (indépendant du plan média)
const controlRooms = new Map(); // meetingId -> Map<socketId, { participantId, userId, displayName, isHost }>

// Mute forcé par l'hôte, mémorisé côté serveur par utilisateur : c'est ce qui
// rend la coupure réellement contraignante. Un client muté qui rafraîchit sa
// page ou re-produit son audio se retrouve repausé côté SFU, sans quoi il
// suffisait d'ignorer l'ordre pour continuer à parler.
const forceMutedUsers = new Map(); // meetingId -> Set<userId>

const controlRoomName = (meetingId) => `ctl:${meetingId}`;

function isUserForceMuted(meetingId, userId) {
  return !!userId && !!forceMutedUsers.get(meetingId)?.has(userId);
}

// ============================================
// INITIALISATION MEDIASOUP
// ============================================

async function createWorkers() {
  const portsPerWorker = Math.floor((RTC_MAX_PORT - RTC_MIN_PORT + 1) / NUM_WORKERS);

  for (let i = 0; i < NUM_WORKERS; i++) {
    const rtcMinPort = RTC_MIN_PORT + i * portsPerWorker;
    const rtcMaxPort = rtcMinPort + portsPerWorker - 1;

    const worker = await mediasoup.createWorker({
      rtcMinPort,
      rtcMaxPort,
      logLevel: mediasoupConfig.worker.logLevel,
      logTags: mediasoupConfig.worker.logTags,
    });

    worker.on('died', (error) => {
      console.error(`❌ Mediasoup Worker ${worker.pid} mort:`, error);
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
    console.log(`✅ Mediasoup Worker ${i + 1}/${NUM_WORKERS} créé [PID: ${worker.pid}] ports ${rtcMinPort}-${rtcMaxPort}`);
  }

  return workers;
}

// Réunions réparties en tourniquet : une réunion vit entièrement sur un
// worker (un router ne peut pas être partagé entre workers), mais deux
// réunions simultanées s'exécutent sur des cœurs différents.
function pickWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

async function getOrCreateRoom(meetingId) {
  if (!rooms.has(meetingId)) {
    const worker = pickWorker();
    console.log(`🏠 Création nouvelle room: ${meetingId} (worker ${worker.pid})`);

    const roomRouter = await worker.createRouter({
      mediaCodecs: mediasoupConfig.router.mediaCodecs,
    });

    // Détecteur de niveau audio : c'est lui qui décide À QUI vont les places de
    // transcription. Sans lui, on transcrivait les trois premiers à produire du
    // son — donc potentiellement trois auditeurs silencieux pendant que ceux qui
    // parlent restaient dehors.
    //
    // ⚠️ `maxEntries` vaut 1 par défaut, ce qui ne remonterait que le plus fort.
    let audioLevelObserver = null;
    if (transcription.ENABLED) {
      try {
        audioLevelObserver = await roomRouter.createAudioLevelObserver({
          maxEntries: transcription.MAX_SESSIONS,
          threshold: -55,   // dBov : en dessous, c'est du bruit de fond
          interval: 400,    // assez court pour ouvrir une place dès les premiers mots
        });
        audioLevelObserver.on('volumes', (volumes) => onVolumes(meetingId, volumes));
      } catch (error) {
        // Le module de transcription ne doit jamais empêcher une réunion
        // d'exister : sans détecteur, on retombe sur l'ordre d'arrivée.
        console.error('🎙️ AudioLevelObserver indisponible:', error.message);
      }
    }

    rooms.set(meetingId, {
      router: roomRouter,
      peers: new Map(),
      audioLevelObserver,
    });
  }

  return rooms.get(meetingId);
}

// ============================================
// ATTRIBUTION DES PLACES DE TRANSCRIPTION
// ============================================
// Le nombre de locuteurs transcrits simultanément reste plafonné par le CPU
// (mesure du transducteur sur cette machine : RTF 0,437, soit environ deux
// locuteurs en régime continu). Ces places vont à qui parle, avec hystérésis :
// ouverture dès le premier mot, fermeture après un vrai silence.

// 30 s et non 3 : entre deux phrases, ou entre deux prises de parole dans une
// discussion, on se tait couramment bien plus longtemps. Refermer vite coûtait
// le début de la phrase suivante, le temps de rétablir le flux. Une place gardée
// plus longtemps ne coûte presque rien : c'est l'inférence qui consomme du CPU,
// pas un flux au repos. La priorité retenue est qu'aucune parole ne manque.
const IDLE_CLOSE_MS = Number(process.env.TRANSCRIPTION_IDLE_CLOSE_MS) || 30000;
const HEARD_FORGET_MS = 60000;
const lastHeardAt = new Map(); // producerId -> horodatage

function onVolumes(meetingId, volumes) {
  const room = rooms.get(meetingId);
  if (!room) return;

  // Écho acoustique : quand un flux est nettement plus faible qu'un autre au
  // même instant, c'est presque toujours la voix du second captée par le micro
  // du premier. On cesse alors de l'envoyer au moteur, faute de quoi la même
  // phrase serait transcrite deux fois sous deux noms différents.
  transcription.applyGate(volumes);

  const now = Date.now();
  for (const { producer } of volumes) {
    lastHeardAt.set(producer.id, now);
    if (transcription.hasStream(producer.id)) continue;

    const peer = Array.from(room.peers.values()).find((p) => p.producers.has(producer.id));
    if (!peer) continue;

    transcription
      .startStream({
        router: room.router,
        producerId: producer.id,
        meetingId,
        speakerName: peer.userName,
        participantId: peer.userId,
        // Le texte revient par le WebSocket qui porte l'audio, et non plus par
        // un rappel HTTP : une connexion de moins, un secret de moins.
        onTranscript: (payload) => recordTranscript(payload),
      })
      .catch((err) => console.error('🎙️ Flux non démarré:', err));
  }
}

if (transcription.ENABLED) {
  // `unref` : ce minuteur ne doit pas à lui seul maintenir le processus en vie.
  setInterval(() => {
    const now = Date.now();

    for (const { producerId, speakerName } of transcription.listStreams()) {
      if (now - (lastHeardAt.get(producerId) || 0) > IDLE_CLOSE_MS) {
        console.log(`🎙️ Place libérée (silence) · ${speakerName}`);
        transcription.stopStream(producerId);
      }
    }

    for (const [producerId, heardAt] of lastHeardAt) {
      if (now - heardAt > HEARD_FORGET_MS) lastHeardAt.delete(producerId);
    }
  }, 1000).unref();
}

// ============================================
// SOCKET.IO - SIGNALISATION
// ============================================

io.on('connection', (socket) => {
  console.log('🔌 Client connecté:', socket.id);

  socket.on('join-room', async ({ roomId, name, userId }, callback) => {
    try {
      console.log(`👤 ${name} (${socket.id}) rejoint la réunion ${roomId}`);

      socket.join(roomId);
      socket.meetingId = roomId;
      socket.userId = userId;
      socket.userName = name;

      const room = await getOrCreateRoom(roomId);

      room.peers.set(socket.id, {
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        userName: name,
        userId,
      });

      socket.to(roomId).emit('peer-joined', { peerId: socket.id, name, userId });

      const existingPeers = Array.from(room.peers.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, peer]) => ({
          peerId: id,
          name: peer.userName,
          userId: peer.userId,
          // Forme détaillée (et non plus une simple liste d'ids) : le nouvel
          // arrivant a besoin du kind et de l'état de pause pour afficher
          // d'emblée les bons badges micro/caméra des gens déjà en ligne.
          sharingScreen: !!peer.sharingScreen,
          producers: Array.from(peer.producers.values()).map((p) => ({
            id: p.id,
            kind: p.kind,
            paused: p.paused,
          })),
        }));

      console.log(`✅ ${name} a rejoint la salle ${roomId} (${room.peers.size} participants)`);

      callback({ success: true, peers: existingPeers, forceMuted: isUserForceMuted(roomId, userId) });
    } catch (error) {
      console.error('❌ Erreur join-room:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('getRtpCapabilities', (callback) => {
    try {
      const room = rooms.get(socket.meetingId);
      if (!room) throw new Error('Pas dans une salle');

      callback({ success: true, rtpCapabilities: room.router.rtpCapabilities });
    } catch (error) {
      console.error('❌ Erreur getRtpCapabilities:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('createWebRtcTransport', async ({ producing }, callback) => {
    try {
      const room = rooms.get(socket.meetingId);
      if (!room) throw new Error('Pas dans une salle');

      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error('Pas de peer');

      const transport = await room.router.createWebRtcTransport({
        ...mediasoupConfig.webRtcTransport,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { producing, peerId: socket.id },
      });

      peer.transports.set(transport.id, transport);

      console.log(`🚚 Transport créé: ${transport.id} (producing: ${producing})`);

      callback({
        success: true,
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (error) {
      console.error('❌ Erreur createWebRtcTransport:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const room = rooms.get(socket.meetingId);
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error('Pas de peer');

      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport introuvable');

      await transport.connect({ dtlsParameters });
      console.log(`🔗 Transport connecté: ${transportId}`);

      callback({ success: true });
    } catch (error) {
      console.error('❌ Erreur connectTransport:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const room = rooms.get(socket.meetingId);
      const peer = room.peers.get(socket.id);
      if (!peer || !room) throw new Error('Pas de peer ou salle');

      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport introuvable');

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: { ...appData, peerId: socket.id, peerName: peer.userName },
      });

      peer.producers.set(producer.id, producer);

      // Un utilisateur muté de force par l'hôte est repausé dès qu'il produit,
      // y compris après un rechargement de page.
      if (kind === 'audio' && isUserForceMuted(socket.meetingId, peer.userId)) {
        await producer.pause();
        console.log(`🔇 Producer audio ${producer.id} pausé (mute forcé actif sur ${peer.userName})`);
      }

      producer.on('transportclose', () => {
        console.log(`🚫 Transport fermé pour producer ${producer.id}`);
        transcription.stopStream(producer.id);
        producer.close();
        peer.producers.delete(producer.id);
      });

      socket.to(socket.meetingId).emit('new-producer', {
        producerId: producer.id,
        peerId: socket.id,
        peerName: peer.userName,
        kind,
        paused: producer.paused,
      });

      // Transcription — désactivée par défaut, et volontairement hors du chemin
      // critique : jamais attendue, jamais capable de faire échouer la
      // production. Si elle casse, la visio continue.
      //
      // On n'ouvre PAS de fork ici : on inscrit le producteur au détecteur de
      // niveau, qui décidera d'ouvrir une place quand cette personne parlera
      // vraiment.
      if (kind === 'audio' && room.audioLevelObserver) {
        room.audioLevelObserver
          .addProducer({ producerId: producer.id })
          .catch((err) => console.error('🎙️ Inscription au détecteur impossible:', err.message));
      }

      console.log(`🎬 Producer créé: ${producer.id} (${kind}) par ${peer.userName}`);

      callback({ success: true, id: producer.id });
    } catch (error) {
      console.error('❌ Erreur produce:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, callback) => {
    try {
      const room = rooms.get(socket.meetingId);
      const peer = room.peers.get(socket.id);
      if (!peer || !room) throw new Error('Pas de peer ou salle');

      const producerPeer = Array.from(room.peers.values()).find(p => p.producers.has(producerId));
      if (!producerPeer) throw new Error('Producer introuvable');

      const producer = producerPeer.producers.get(producerId);
      if (!producer) throw new Error('Producer introuvable');

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume');
      }

      // Le client crée un transport de réception par pair distant et nous dit
      // lequel utiliser. Prendre à la place « le premier transport non
      // producteur venu » créait le consumer sur un transport DTLS différent
      // de celui sur lequel le client l'attendait : à partir du 3e
      // participant, le flux n'arrivait jamais.
      const consumerTransport = transportId
        ? peer.transports.get(transportId)
        : Array.from(peer.transports.values()).find(t => t.appData.producing === false);

      if (!consumerTransport) throw new Error('Transport de réception introuvable');

      const consumer = await consumerTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        console.log(`🚫 Transport fermé pour consumer ${consumer.id}`);
        consumer.close();
        peer.consumers.delete(consumer.id);
      });

      consumer.on('producerclose', () => {
        console.log(`🚫 Producer fermé pour consumer ${consumer.id}`);
        socket.emit('producer-closed', { producerId });
        consumer.close();
        peer.consumers.delete(consumer.id);
      });

      console.log(`📺 Consumer créé: ${consumer.id} pour producer ${producerId}`);

      callback({
        success: true,
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
      });
    } catch (error) {
      console.error('❌ Erreur consume:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Fermer un producer côté serveur (ex: l'utilisateur coupe sa caméra/micro
  // en cours d'appel) et notifier les autres participants pour qu'ils
  // nettoient leur affichage.
  socket.on('closeProducer', ({ producerId }, callback) => {
    try {
      const room = rooms.get(socket.meetingId);
      const peer = room?.peers.get(socket.id);
      if (!peer) throw new Error('Pas de peer');

      const producer = peer.producers.get(producerId);
      if (producer) {
        transcription.stopStream(producerId);
        producer.close();
        peer.producers.delete(producerId);

        socket.to(socket.meetingId).emit('producer-closed', {
          producerId,
          peerId: socket.id,
        });

        console.log(`🚫 Producer fermé manuellement: ${producerId} par ${peer.userName}`);
      }

      if (callback) callback({ success: true });
    } catch (error) {
      console.error('❌ Erreur closeProducer:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Couper/rétablir un flux sans détruire le producer. Préférable à
  // closeProducer pour le micro et la caméra : les consumers distants restent
  // vivants, donc rallumer est instantané et n'oblige personne à
  // renégocier — et surtout les autres participants sont notifiés, ce qui
  // permet d'afficher qui est muet.
  socket.on('pauseProducer', async ({ producerId }, callback) => {
    try {
      const peer = rooms.get(socket.meetingId)?.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);
      if (!producer) throw new Error('Producer introuvable');

      await producer.pause();
      io.to(socket.meetingId).emit('producer-paused', {
        producerId,
        peerId: socket.id,
        kind: producer.kind,
      });

      if (callback) callback({ success: true });
    } catch (error) {
      console.error('❌ Erreur pauseProducer:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('resumeProducer', async ({ producerId }, callback) => {
    try {
      const peer = rooms.get(socket.meetingId)?.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);
      if (!producer) throw new Error('Producer introuvable');

      // Le mute forcé de l'hôte prime sur la volonté du participant.
      if (producer.kind === 'audio' && isUserForceMuted(socket.meetingId, peer.userId)) {
        if (callback) callback({ success: false, error: "Micro coupé par l'hôte" });
        return;
      }

      await producer.resume();
      io.to(socket.meetingId).emit('producer-resumed', {
        producerId,
        peerId: socket.id,
        kind: producer.kind,
      });

      if (callback) callback({ success: true });
    } catch (error) {
      console.error('❌ Erreur resumeProducer:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      const peer = rooms.get(socket.meetingId)?.peers.get(socket.id);
      if (!peer) throw new Error('Pas de peer');

      const consumer = peer.consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer introuvable');

      await consumer.resume();
      console.log('▶️ Consumer resumed:', consumerId);

      callback({ success: true });
    } catch (error) {
      console.error('❌ Erreur resumeConsumer:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Lever/baisser la main — signal éphémère, pas de persistance en base,
  // juste un relais aux autres participants de la salle.
  socket.on('toggle-hand', ({ raised }) => {
    if (!socket.meetingId) return;
    socket.to(socket.meetingId).emit('hand-toggled', { peerId: socket.id, userId: socket.userId, raised });
  });

  // Le partage d'écran réutilise le producer vidéo existant (replaceTrack) :
  // rien dans le flux ne dit aux autres que ce n'est plus une caméra. Sans ce
  // signal, ils affichent l'écran partagé rogné, comme un visage.
  socket.on('screen-share', ({ sharing }) => {
    if (!socket.meetingId) return;
    const room = rooms.get(socket.meetingId);
    const peer = room?.peers.get(socket.id);
    if (peer) peer.sharingScreen = !!sharing;

    // Un seul partage a la fois, et c'est le dernier qui gagne.
    //
    // Rien n'empechait deux personnes de partager en meme temps : la scene
    // n'en met qu'une en avant et l'autre atterrissait dans le bandeau de
    // vignettes, minuscule, sans que personne ne comprenne pourquoi. Le
    // arbitrage se fait ici et non dans l'interface : chaque client ne connait
    // que ce que le serveur lui annonce, deux d'entre eux pourraient se croire
    // legitimes en meme temps.
    //
    // Le dernier l'emporte, comme dans Meet — refuser le nouveau partage (choix
    // de Zoom) oblige celui qui presente a demander a l'autre de s'arreter, ce
    // qui se negocie mal quand on est en train de parler.
    if (sharing && room) {
      for (const [peerId, other] of room.peers) {
        if (peerId === socket.id || !other.sharingScreen) continue;

        other.sharingScreen = false;
        // Au partageur precedent : son client doit vraiment rendre la camera,
        // le serveur ne peut pas remplacer sa piste a sa place.
        io.to(peerId).emit('screen-share-revoked', { byName: socket.userName || 'Un participant' });
        // Et a toute la salle, pour que sa tuile cesse d'etre annoncee comme
        // un ecran partage.
        io.to(socket.meetingId).emit('peer-screen-share', { peerId, sharing: false });

        console.log(`🖥️ Partage repris par ${socket.userName} — ${other.userName} interrompu`);
      }
    }

    socket.to(socket.meetingId).emit('peer-screen-share', { peerId: socket.id, sharing: !!sharing });
  });

  /**
   * Inventaire des flux de la salle, hors les siens.
   *
   * Filet de securite pour le client : une consommation qui echoue le laissait
   * sans tuile pour ce participant jusqu'a la fin de la reunion, puisque
   * `new-producer` n'est emis qu'une fois. Le client compare periodiquement cet
   * inventaire a ce qu'il a reellement recu et redemande la difference.
   */
  socket.on('list-producers', (callback) => {
    if (typeof callback !== 'function') return;

    const room = socket.meetingId && rooms.get(socket.meetingId);
    if (!room) {
      callback({ success: false, error: 'Salle inconnue' });
      return;
    }

    const producers = [];
    for (const [peerId, peer] of room.peers) {
      if (peerId === socket.id) continue;
      for (const producer of peer.producers.values()) {
        producers.push({
          producerId: producer.id,
          peerId,
          peerName: peer.userName,
          kind: producer.kind,
          paused: producer.paused,
        });
      }
    }

    callback({ success: true, producers });
  });

  // Quitter volontairement la salle (l'utilisateur clique "Quitter", ou est
  // exclu par l'hôte côté application) sans fermer la connexion Socket.io —
  // permet au client de revenir à l'écran de salle d'attente proprement.
  socket.on('leave-room', (callback) => {
    cleanupPeer(socket);
    if (callback) callback({ success: true });
  });

  // ==========================================================================
  // PLAN DE CONTRÔLE
  // ==========================================================================
  // Rejoint dès l'ouverture de la page /room/<code>, avant même l'admission :
  // c'est ce qui permet à un invité coincé en salle d'attente d'apprendre
  // qu'on vient de l'admettre, et à l'hôte de voir la demande arriver.

  socket.on('control:join', ({ meetingId, participantId, userId, displayName, isHost }, callback) => {
    try {
      if (!meetingId) throw new Error('meetingId manquant');

      socket.join(controlRoomName(meetingId));
      socket.data.control = { meetingId, participantId, userId, displayName, isHost: !!isHost };

      if (!controlRooms.has(meetingId)) controlRooms.set(meetingId, new Map());
      controlRooms.get(meetingId).set(socket.id, socket.data.control);

      console.log(`🎛️ ${displayName} suit la réunion ${meetingId} (contrôle)`);

      // Signal générique : chaque client recharge sa liste depuis Supabase.
      // C'est ce qui fait apparaître une demande d'admission chez l'hôte sans
      // qu'il ait à rafraîchir.
      socket.to(controlRoomName(meetingId)).emit('control:dirty', { reason: 'join', participantId });

      // Rattrapage du transcript : sans cet envoi, arriver en retard ou
      // recharger la page donnerait un panneau vide jusqu'à la phrase suivante.
      const store = transcripts.get(meetingId);
      if (store && (store.finals.length || store.partials.size)) {
        socket.emit('control:transcript-state', {
          finals: store.finals,
          partials: Array.from(store.partials.values()),
        });
      }

      if (callback) {
        callback({ success: true, forceMuted: isUserForceMuted(meetingId, userId) });
      }
    } catch (error) {
      console.error('❌ Erreur control:join:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // L'auteur de la modification a déjà écrit dans Supabase ; on se contente de
  // propager le changement en direct et d'appliquer ce qui doit l'être côté
  // média (mute forcé, exclusion), que la base ne peut pas imposer seule.
  socket.on('control:participant-updated', async ({ meetingId, participantId, userId, patch }, callback) => {
    try {
      if (!meetingId || !patch) throw new Error('Paramètres manquants');

      if (Object.prototype.hasOwnProperty.call(patch, 'force_muted')) {
        await applyForceMute(meetingId, userId, !!patch.force_muted);
      }

      if (patch.status === 'removed' || patch.status === 'denied') {
        ejectFromMeeting(meetingId, userId, patch.status);
      }

      io.to(controlRoomName(meetingId)).emit('control:participant-updated', {
        participantId,
        userId,
        patch,
      });

      if (callback) callback({ success: true });
    } catch (error) {
      console.error('❌ Erreur control:participant-updated:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('control:meeting-updated', ({ meetingId, patch }, callback) => {
    try {
      if (!meetingId || !patch) throw new Error('Paramètres manquants');
      io.to(controlRoomName(meetingId)).emit('control:meeting-updated', { patch });
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('❌ Erreur control:meeting-updated:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Le message est persisté dans Supabase par l'émetteur ; ce relais sert
  // uniquement à l'affichage immédiat chez les autres.
  socket.on('control:chat', ({ meetingId, message }) => {
    if (!meetingId || !message) return;
    socket.to(controlRoomName(meetingId)).emit('control:chat', { message });
  });

  // Réaction emoji ajoutée ou retirée. Même principe que ci-dessus : la table
  // meeting_message_reactions a déjà été mise à jour par l'émetteur, qui a
  // aussi appliqué le changement chez lui — on ne relaie qu'aux autres.
  socket.on('control:chat-reaction', ({ meetingId, reaction }) => {
    if (!meetingId || !reaction) return;
    socket.to(controlRoomName(meetingId)).emit('control:chat-reaction', { reaction });
  });

  socket.on('control:leave', (callback) => {
    cleanupControl(socket);
    if (callback) callback({ success: true });
  });

  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion:', socket.id);
    cleanupPeer(socket);
    cleanupControl(socket);
  });
});

/**
 * Applique un mute forcé côté SFU : les producers audio de la cible sont
 * pausés sur le serveur, donc plus aucun paquet n'est relayé aux autres,
 * indépendamment de ce que fait son navigateur.
 *
 * Le dé-mute ne rallume volontairement pas le micro : il lève l'interdiction
 * et laisse la personne se réactiver elle-même (comportement attendu — l'hôte
 * ne doit pas pouvoir ouvrir un micro à distance).
 */
async function applyForceMute(meetingId, userId, muted) {
  if (!userId) return;

  if (!forceMutedUsers.has(meetingId)) forceMutedUsers.set(meetingId, new Set());
  const muteSet = forceMutedUsers.get(meetingId);

  if (muted) muteSet.add(userId);
  else muteSet.delete(userId);

  const room = rooms.get(meetingId);
  if (room) {
    for (const [peerSocketId, peer] of room.peers.entries()) {
      if (peer.userId !== userId) continue;

      for (const producer of peer.producers.values()) {
        if (producer.kind !== 'audio') continue;
        if (muted && !producer.paused) {
          await producer.pause();
          io.to(meetingId).emit('producer-paused', {
            producerId: producer.id,
            peerId: peerSocketId,
            kind: 'audio',
          });
        }
      }

      io.to(peerSocketId).emit('force-muted', { muted });
    }
  }

  // La cible peut être en salle d'attente (pas encore de peer média) : on la
  // prévient aussi sur son canal de contrôle.
  for (const [ctlSocketId, member] of controlRooms.get(meetingId)?.entries() || []) {
    if (member.userId === userId) io.to(ctlSocketId).emit('force-muted', { muted });
  }

  console.log(`${muted ? '🔇' : '🔊'} Mute forcé ${muted ? 'activé' : 'levé'} pour ${userId}`);
}

/**
 * Exclure quelqu'un : on coupe son média immédiatement plutôt que d'attendre
 * qu'il veuille bien réagir à son propre statut en base.
 */
function ejectFromMeeting(meetingId, userId, status) {
  if (!userId) return;

  const room = rooms.get(meetingId);
  if (room) {
    for (const peerSocketId of Array.from(room.peers.keys())) {
      const peer = room.peers.get(peerSocketId);
      if (peer?.userId !== userId) continue;

      const targetSocket = io.sockets.sockets.get(peerSocketId);
      if (targetSocket) cleanupPeer(targetSocket);
    }
  }

  for (const [ctlSocketId, member] of controlRooms.get(meetingId)?.entries() || []) {
    if (member.userId === userId) io.to(ctlSocketId).emit('control:ejected', { status });
  }

  console.log(`⛔ ${userId} exclu de la réunion ${meetingId} (${status})`);
}

function cleanupControl(socket) {
  const control = socket.data?.control;
  if (!control) return;

  const members = controlRooms.get(control.meetingId);
  if (members) {
    members.delete(socket.id);
    if (members.size === 0) {
      controlRooms.delete(control.meetingId);
      // Plus personne dans la réunion : le mute forcé mémorisé n'a plus de
      // sens et ne doit pas survivre à la prochaine réunion.
      forceMutedUsers.delete(control.meetingId);
    }
  }

  socket.to(controlRoomName(control.meetingId)).emit('control:dirty', {
    reason: 'leave',
    participantId: control.participantId,
  });

  socket.leave(controlRoomName(control.meetingId));
  socket.data.control = null;
}

function cleanupPeer(socket) {
  if (!socket.meetingId) return;

  const room = rooms.get(socket.meetingId);
  if (!room) return;

  const peer = room.peers.get(socket.id);
  if (!peer) return;

  peer.producers.forEach(producer => {
    socket.to(socket.meetingId).emit('producer-closed', {
      producerId: producer.id,
      peerId: socket.id,
    });
    transcription.stopStream(producer.id);
    producer.close();
  });

  peer.consumers.forEach(consumer => consumer.close());
  peer.transports.forEach(transport => transport.close());

  room.peers.delete(socket.id);

  socket.to(socket.meetingId).emit('peer-left', { peerId: socket.id });
  socket.leave(socket.meetingId);

  console.log(`👋 ${peer.userName} a quitté la salle ${socket.meetingId}`);

  if (room.peers.size === 0) {
    // Avant de fermer le router : ffmpeg doit recevoir un SIGTERM pour
    // finaliser l'en-tête de son WAV. Fermer le router d'abord tronquerait le
    // fichier, et le rendrait illisible.
    transcription.stopMeetingStreams(socket.meetingId);

    room.router.close();
    rooms.delete(socket.meetingId);
    transcripts.delete(socket.meetingId);
    console.log('🗑️ Room supprimée:', socket.meetingId);
  }
}

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

const PORT = process.env.MEDIASOUP_PORT || 3001;

async function startServer() {
  try {
    console.log('🚀 Démarrage du serveur Mediasoup...');

    await createWorkers();

    server.listen(PORT, () => {
      console.log(`✅ Serveur Mediasoup actif sur le port ${PORT}`);
      console.log(`⚙️  ${NUM_WORKERS} worker(s) · ports RTC ${RTC_MIN_PORT}-${RTC_MAX_PORT}`);
      console.log(`📡 Socket.io prêt pour les connexions`);
      console.log(`🌍 Client URL: ${process.env.CLIENT_URL || 'http://localhost:3000'}`);
    });
  } catch (error) {
    console.error('❌ Erreur démarrage serveur:', error);
    process.exit(1);
  }
}

startServer();
