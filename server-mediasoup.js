/**
 * SERVEUR MEDIASOUP - SFU pour Stark Meet
 * Architecture: Selective Forwarding Unit (SFU)
 *
 * Ce serveur gère uniquement le média (audio/vidéo WebRTC) et sa
 * signalisation. La salle d'attente, le verrouillage de salle et la
 * modération (mute forcé, exclusion) sont gérés côté application via
 * Supabase (table meeting_participants + Realtime) — chaque client réagit
 * à son propre statut plutôt que de dépendre d'un canal de contrôle ici.
 *
 * À lancer avec: node server-mediasoup.js
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

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

app.use(express.json());

// ============================================
// CONFIGURATION MEDIASOUP
// ============================================

const mediasoupConfig = {
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
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

let worker;
const rooms = new Map(); // meetingId -> { router, peers: Map<socketId, peer> }

// ============================================
// INITIALISATION MEDIASOUP
// ============================================

async function createWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: mediasoupConfig.worker.rtcMinPort,
    rtcMaxPort: mediasoupConfig.worker.rtcMaxPort,
    logLevel: mediasoupConfig.worker.logLevel,
    logTags: mediasoupConfig.worker.logTags,
  });

  console.log('✅ Mediasoup Worker créé [PID:', worker.pid, ']');

  worker.on('died', (error) => {
    console.error('❌ Mediasoup Worker mort:', error);
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
}

async function getOrCreateRoom(meetingId) {
  if (!rooms.has(meetingId)) {
    console.log('🏠 Création nouvelle room:', meetingId);

    const roomRouter = await worker.createRouter({
      mediaCodecs: mediasoupConfig.router.mediaCodecs,
    });

    rooms.set(meetingId, {
      router: roomRouter,
      peers: new Map(),
    });
  }

  return rooms.get(meetingId);
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
          producers: Array.from(peer.producers.keys()),
        }));

      console.log(`✅ ${name} a rejoint la salle ${roomId} (${room.peers.size} participants)`);

      callback({ success: true, peers: existingPeers });
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

      producer.on('transportclose', () => {
        console.log(`🚫 Transport fermé pour producer ${producer.id}`);
        producer.close();
        peer.producers.delete(producer.id);
      });

      socket.to(socket.meetingId).emit('new-producer', {
        producerId: producer.id,
        peerId: socket.id,
        peerName: peer.userName,
      });

      console.log(`🎬 Producer créé: ${producer.id} (${kind}) par ${peer.userName}`);

      callback({ success: true, id: producer.id });
    } catch (error) {
      console.error('❌ Erreur produce:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
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

      let consumerTransport = Array.from(peer.transports.values())
        .find(t => t.appData.producing === false);

      if (!consumerTransport) {
        consumerTransport = await room.router.createWebRtcTransport({
          ...mediasoupConfig.webRtcTransport,
          appData: { producing: false, peerId: socket.id },
        });
        peer.transports.set(consumerTransport.id, consumerTransport);
      }

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

  // Quitter volontairement la salle (l'utilisateur clique "Quitter", ou est
  // exclu par l'hôte côté application) sans fermer la connexion Socket.io —
  // permet au client de revenir à l'écran de salle d'attente proprement.
  socket.on('leave-room', (callback) => {
    cleanupPeer(socket);
    if (callback) callback({ success: true });
  });

  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion:', socket.id);
    cleanupPeer(socket);
  });
});

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
    producer.close();
  });

  peer.consumers.forEach(consumer => consumer.close());
  peer.transports.forEach(transport => transport.close());

  room.peers.delete(socket.id);

  socket.to(socket.meetingId).emit('peer-left', { peerId: socket.id });
  socket.leave(socket.meetingId);

  console.log(`👋 ${peer.userName} a quitté la salle ${socket.meetingId}`);

  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(socket.meetingId);
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

    await createWorker();

    server.listen(PORT, () => {
      console.log(`✅ Serveur Mediasoup actif sur le port ${PORT}`);
      console.log(`📡 Socket.io prêt pour les connexions`);
      console.log(`🌍 Client URL: ${process.env.CLIENT_URL || 'http://localhost:3000'}`);
    });
  } catch (error) {
    console.error('❌ Erreur démarrage serveur:', error);
    process.exit(1);
  }
}

startServer();
