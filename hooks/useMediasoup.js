/**
 * Hook useMediasoup - Client MediaSoup
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import * as mediasoupClient from 'mediasoup-client';
import io from 'socket.io-client';

const MEDIASOUP_SERVER_URL = process.env.NEXT_PUBLIC_MEDIASOUP_URL || 'http://localhost:3001';

export default function useMediasoup(meetingId, userId, userName) {
  // États
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const [remotePeers, setRemotePeers] = useState({}); // peerId -> { peerId, name, userId }
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState({}); // userId -> bool (participants distants)
  const [remoteMediaState, setRemoteMediaState] = useState({}); // peerId -> { audioPaused, videoPaused }
  const [isForceMuted, setIsForceMuted] = useState(false);

  // Refs (persistent across renders)
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const producerTransportRef = useRef(null);
  // Un unique transport de réception pour TOUS les pairs distants. Un
  // transport par pair consommait 2 ports UDP/TCP par participant distant sur
  // le serveur (plage limitée) et imposait une négociation ICE/DTLS complète à
  // chaque arrivée. Un seul suffit : un transport mediasoup porte autant de
  // consumers qu'on veut.
  const consumerTransportRef = useRef(null);
  const consumerTransportPromiseRef = useRef(null);
  const videoProducerRef = useRef(null);
  const audioProducerRef = useRef(null);
  const cameraTrackRef = useRef(null); // piste caméra mise de côté pendant un partage d'écran
  const consumersRef = useRef(new Map()); // consumerId -> consumer
  const peersRef = useRef(new Map()); // peerId -> { peerId, name }
  const producerOwnersRef = useRef(new Map()); // producerId distant -> { peerId, kind }

  // Le stream local est aussi gardé en ref : les callbacks mémoïsés
  // (toggleMic, toggleVideo…) sont recréés à chaque changement de
  // `localStream`, et un handler socket enregistré une seule fois au montage
  // lirait sinon un stream périmé.
  const localStreamRef = useRef(null);

  const applyLocalStream = useCallback((stream) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
  }, []);

  const markRemoteMedia = useCallback((peerId, kind, paused) => {
    if (!peerId || !kind) return;
    const field = kind === 'audio' ? 'audioPaused' : 'videoPaused';
    setRemoteMediaState(prev => ({
      ...prev,
      [peerId]: { ...(prev[peerId] || {}), [field]: paused },
    }));
  }, []);

  /**
   * Connexion au serveur Socket.io
   */
  const connectToServer = useCallback(() => {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Connexion au serveur ${MEDIASOUP_SERVER_URL}...`);

      socketRef.current = io(MEDIASOUP_SERVER_URL);

      socketRef.current.on('connect', () => {
        console.log('✅ Connecté au serveur');
        setIsConnected(true);
        resolve();
      });

      socketRef.current.on('disconnect', () => {
        console.log('❌ Déconnecté du serveur');
        setIsConnected(false);
      });

      socketRef.current.on('connect_error', (err) => {
        console.error('❌ Erreur de connexion:', err);
        setIsConnected(false);
        setError('Erreur de connexion au serveur');
        reject(err);
      });

      // Événements de la salle
      socketRef.current.on('new-producer', handleNewProducer);
      socketRef.current.on('producer-closed', handleProducerClosed);
      socketRef.current.on('peer-joined', handlePeerJoined);
      socketRef.current.on('peer-left', handlePeerLeft);
      socketRef.current.on('hand-toggled', handleHandToggled);
      socketRef.current.on('producer-paused', handleProducerPaused);
      socketRef.current.on('producer-resumed', handleProducerResumed);
      socketRef.current.on('force-muted', handleForceMuted);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Rejoindre la salle via Socket.io
   */
  const joinRoomSocket = useCallback((roomId, name) => {
    return new Promise((resolve, reject) => {
      console.log(`📨 Rejoindre la salle ${roomId} en tant que ${name}...`);

      socketRef.current.emit('join-room', { roomId, name, userId }, (response) => {
        if (response.success) {
          console.log('✅ Salle rejointe, participants:', response.peers);

          // Ajouter les participants existants
          response.peers.forEach(peer => {
            peersRef.current.set(peer.peerId, peer);
          });
          setRemotePeers(prev => {
            const updated = { ...prev };
            response.peers.forEach(peer => { updated[peer.peerId] = peer; });
            return updated;
          });

          resolve(response);
        } else {
          console.error('❌ Erreur join-room:', response.error);
          reject(new Error(response.error));
        }
      });
    });
  }, [userId]);

  /**
   * Charger le device MediaSoup
   */
  const loadDevice = useCallback(() => {
    return new Promise((resolve, reject) => {
      socketRef.current.emit('getRtpCapabilities', async (response) => {
        if (!response.success) {
          reject(new Error(response.error));
          return;
        }

        try {
          deviceRef.current = new mediasoupClient.Device();
          await deviceRef.current.load({ routerRtpCapabilities: response.rtpCapabilities });
          console.log('✅ Device MediaSoup chargé');
          resolve();
        } catch (err) {
          console.error('❌ Erreur de chargement du device:', err);
          reject(err);
        }
      });
    });
  }, []);

  /**
   * Créer le transport de production
   */
  const createProducerTransport = useCallback(() => {
    return new Promise((resolve, reject) => {
      socketRef.current.emit('createWebRtcTransport', { producing: true }, async (response) => {
        if (!response.success) {
          reject(new Error(response.error));
          return;
        }

        try {
          producerTransportRef.current = deviceRef.current.createSendTransport(response.params);

          // Événement connect
          producerTransportRef.current.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
              await new Promise((res, rej) => {
                socketRef.current.emit('connectTransport', {
                  transportId: producerTransportRef.current.id,
                  dtlsParameters
                }, (resp) => {
                  resp.success ? res() : rej(new Error(resp.error));
                });
              });
              callback();
            } catch (err) {
              errback(err);
            }
          });

          // Événement produce
          producerTransportRef.current.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
            try {
              const { id } = await new Promise((res, rej) => {
                socketRef.current.emit('produce', {
                  transportId: producerTransportRef.current.id,
                  kind,
                  rtpParameters,
                  appData
                }, (resp) => {
                  resp.success ? res(resp) : rej(new Error(resp.error));
                });
              });
              callback({ id });
            } catch (err) {
              errback(err);
            }
          });

          console.log('✅ Transport de production créé');
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }, []);

  /**
   * Produire audio ou vidéo
   */
  const produce = useCallback(async (kind, stream) => {
    // Accepte le stream explicitement plutôt que de lire `localStream` par
    // fermeture : joinMeeting() appelle produce() juste après
    // setLocalStream(), avant que le composant ne se re-rende, donc la
    // fermeture de `produce` capturée au montage verrait encore
    // `localStream` à null. Passer le stream en paramètre évite ce bug.
    const activeStream = stream || localStream;
    const track = kind === 'video'
      ? activeStream.getVideoTracks()[0]
      : activeStream.getAudioTracks()[0];

    if (!track) {
      console.warn(`⚠️ Pas de track ${kind}`);
      return;
    }

    try {
      const producer = await producerTransportRef.current.produce({ track });

      if (kind === 'video') {
        videoProducerRef.current = producer;
      } else {
        audioProducerRef.current = producer;
      }

      producer.on('trackended', () => {
        console.log(`Track ${kind} terminé`);
      });

      producer.on('transportclose', () => {
        console.log(`Transport fermé pour ${kind}`);
      });

      console.log(`✅ Production ${kind} démarrée (producer: ${producer.id})`);
    } catch (err) {
      console.error(`❌ Erreur de production ${kind}:`, err);
      setError(`Impossible de produire ${kind}`);
    }
  }, [localStream]);

  /**
   * Gérer un nouveau producer (autre participant)
   */
  const handleNewProducer = useCallback(async ({ producerId, peerId, peerName, kind, paused }) => {
    console.log(`📺 Nouveau producer: ${producerId} de ${peerName} (peerId: ${peerId})`);

    // Ajouter le peer s'il n'existe pas
    if (!peersRef.current.has(peerId)) {
      const info = { peerId, name: peerName };
      peersRef.current.set(peerId, info);
      setRemotePeers(prev => ({ ...prev, [peerId]: info }));
    }

    if (kind) markRemoteMedia(peerId, kind, !!paused);

    // Consommer le producer
    // Note: `consume` est déclaré plus bas dans ce fichier — on ne peut pas
    // le référencer dans ce tableau de dépendances (erreur "Cannot access
    // before initialization"). Sa référence est de toute façon stable
    // (dépend uniquement de createConsumerTransport, dont les deps sont []).
    await consume(producerId, peerId, peerName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markRemoteMedia]);

  /**
   * Créer un transport de consommation
   */
  const createConsumerTransport = useCallback(() => {
    return new Promise((resolve, reject) => {
      socketRef.current.emit('createWebRtcTransport', { producing: false }, async (response) => {
        if (!response.success) {
          reject(new Error(response.error));
          return;
        }

        try {
          const consumerTransport = deviceRef.current.createRecvTransport(response.params);

          consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
              await new Promise((res, rej) => {
                socketRef.current.emit('connectTransport', {
                  transportId: consumerTransport.id,
                  dtlsParameters
                }, (resp) => {
                  resp.success ? res() : rej(new Error(resp.error));
                });
              });
              callback();
            } catch (err) {
              errback(err);
            }
          });

          resolve(consumerTransport);
        } catch (err) {
          reject(err);
        }
      });
    });
  }, []);

  /**
   * Consommer un producer distant
   */
  const consume = useCallback(async (producerId, peerId, peerName) => {
    try {
      // Créer le transport de réception à la première consommation. La
      // promesse est mémorisée : plusieurs `consume` peuvent partir en
      // parallèle (arrivée simultanée d'un flux audio et d'un flux vidéo) et
      // créeraient sinon deux transports concurrents.
      if (!consumerTransportRef.current) {
        if (!consumerTransportPromiseRef.current) {
          consumerTransportPromiseRef.current = createConsumerTransport();
        }
        consumerTransportRef.current = await consumerTransportPromiseRef.current;
      }
      const consumerTransport = consumerTransportRef.current;

      // Demander au serveur de consommer
      return new Promise((resolve, reject) => {
        socketRef.current.emit('consume', {
          producerId,
          rtpCapabilities: deviceRef.current.rtpCapabilities,
          // Indispensable : sans ça le serveur choisissait « le premier
          // transport de réception venu », qui n'était pas celui sur lequel
          // on consomme dès qu'un 3e participant entrait dans la salle.
          transportId: consumerTransport.id,
        }, async (response) => {
          if (!response.success) {
            reject(new Error(response.error));
            return;
          }

          try {
            const consumer = await consumerTransport.consume({
              id: response.id,
              producerId: response.producerId,
              kind: response.kind,
              rtpParameters: response.rtpParameters
            });

            consumersRef.current.set(consumer.id, consumer);
            producerOwnersRef.current.set(response.producerId, { peerId, kind: response.kind });
            markRemoteMedia(peerId, response.kind, !!response.producerPaused);

            // Ajouter le track au stream distant AVANT de reprendre
            setRemoteStreams(prev => {
              const existingStream = prev[peerId];
              let newStream;

              if (existingStream) {
                // Ajouter le track au stream existant
                const clonedStream = existingStream.clone();
                clonedStream.addTrack(consumer.track);
                newStream = clonedStream;
              } else {
                // Créer un nouveau stream
                newStream = new MediaStream([consumer.track]);
              }

              console.log(`✅ Stream mis à jour pour peerId ${peerId}:`, {
                kind: consumer.kind,
                totalTracks: newStream.getTracks().length,
                videoTracks: newStream.getVideoTracks().length,
                audioTracks: newStream.getAudioTracks().length
              });

              return { ...prev, [peerId]: newStream };
            });

            // Reprendre le consumer
            socketRef.current.emit('resumeConsumer', { consumerId: consumer.id }, (resp) => {
              if (resp.success) {
                console.log(`✅ Consumer ${consumer.id} (${response.kind}) resumed`);
              } else {
                console.error('❌ Erreur resume consumer:', resp.error);
              }
            });

            consumer.on('transportclose', () => {
              consumersRef.current.delete(consumer.id);
            });

            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    } catch (err) {
      console.error('❌ Erreur consume:', err);
    }
  }, [createConsumerTransport, markRemoteMedia]);

  /**
   * Gérer la fermeture d'un producer
   */
  const handleProducerClosed = useCallback(({ producerId, peerId }) => {
    console.log(`🚫 Producer fermé: ${producerId} (peerId: ${peerId})`);

    const owner = producerOwnersRef.current.get(producerId);
    const ownerPeerId = peerId || owner?.peerId;

    // Trouver et fermer le consumer correspondant
    for (const [consumerId, consumer] of consumersRef.current.entries()) {
      if (consumer.producerId !== producerId) continue;

      // Retirer la piste du stream distant : sans ça le <video> restait figé
      // sur la dernière image reçue au lieu de retomber sur l'avatar.
      if (ownerPeerId) {
        const deadTrack = consumer.track;
        setRemoteStreams(prev => {
          const stream = prev[ownerPeerId];
          if (!stream) return prev;
          const remaining = stream.getTracks().filter(t => t.id !== deadTrack.id);
          return { ...prev, [ownerPeerId]: new MediaStream(remaining) };
        });
      }

      consumer.close();
      consumersRef.current.delete(consumerId);
    }

    if (ownerPeerId && owner?.kind) markRemoteMedia(ownerPeerId, owner.kind, true);
    producerOwnersRef.current.delete(producerId);
  }, [markRemoteMedia]);

  /**
   * Un participant distant a coupé (ou s'est fait couper) son micro/sa caméra.
   * Le producer reste vivant côté serveur, seul le relais est suspendu — on
   * met donc simplement à jour les badges de sa tuile.
   */
  const handleProducerPaused = useCallback(({ producerId, peerId, kind }) => {
    const owner = producerOwnersRef.current.get(producerId);
    markRemoteMedia(peerId || owner?.peerId, kind || owner?.kind, true);
  }, [markRemoteMedia]);

  const handleProducerResumed = useCallback(({ producerId, peerId, kind }) => {
    const owner = producerOwnersRef.current.get(producerId);
    markRemoteMedia(peerId || owner?.peerId, kind || owner?.kind, false);
  }, [markRemoteMedia]);

  /**
   * L'hôte m'a coupé (ou rendu) le micro. Le serveur a déjà suspendu le relais
   * de mon audio ; on aligne l'état local pour que l'interface soit cohérente
   * et que la piste cesse réellement de capter.
   */
  const handleForceMuted = useCallback(({ muted }) => {
    setIsForceMuted(muted);

    if (muted) {
      const track = localStreamRef.current?.getAudioTracks()[0];
      if (track) track.enabled = false;
      if (audioProducerRef.current && !audioProducerRef.current.paused) {
        audioProducerRef.current.pause();
      }
      setIsMicOn(false);
    }
  }, []);

  /**
   * Gérer l'arrivée d'un nouveau participant
   */
  const handlePeerJoined = useCallback(({ peerId, name, userId: remoteUserId }) => {
    console.log(`👋 ${name} a rejoint la salle (peerId: ${peerId})`);
    const info = { peerId, name, userId: remoteUserId };
    peersRef.current.set(peerId, info);
    setRemotePeers(prev => ({ ...prev, [peerId]: info }));
  }, []);

  /**
   * Gérer le départ d'un participant
   */
  const handlePeerLeft = useCallback(({ peerId }) => {
    console.log(`👋 Participant ${peerId} est parti`);

    const leavingPeer = peersRef.current.get(peerId);

    // Supprimer le stream distant
    setRemoteStreams(prev => {
      const newStreams = { ...prev };
      delete newStreams[peerId];
      return newStreams;
    });

    // Supprimer le peer
    peersRef.current.delete(peerId);
    setRemotePeers(prev => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });

    if (leavingPeer?.userId) {
      setRaisedHands(prev => {
        const updated = { ...prev };
        delete updated[leavingPeer.userId];
        return updated;
      });
    }

    setRemoteMediaState(prev => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });

    for (const [producerId, owner] of producerOwnersRef.current.entries()) {
      if (owner.peerId === peerId) producerOwnersRef.current.delete(producerId);
    }

    // Le transport de réception est partagé entre tous les pairs : il ne se
    // ferme pas au départ de l'un d'eux, seuls ses consumers disparaissent
    // (le serveur les ferme via `producerclose`).
  }, []);

  /**
   * Gérer le lever/baisser de main d'un participant distant
   */
  const handleHandToggled = useCallback(({ userId, raised }) => {
    if (!userId) return;
    setRaisedHands(prev => ({ ...prev, [userId]: raised }));
  }, []);

  /**
   * Lever/baisser ma propre main — signal éphémère relayé aux autres via
   * Mediasoup (pas de persistance en base, comme le mic/la caméra).
   */
  const toggleHand = useCallback(() => {
    setIsHandRaised(prev => {
      const next = !prev;
      socketRef.current?.emit('toggle-hand', { raised: next });
      return next;
    });
  }, []);

  /**
   * Initialiser le média local (caméra et micro)
   */
  const initLocalMedia = useCallback(async () => {
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    const videoConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    };

    try {
      console.log('📹 Demande d\'accès caméra/micro...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints
      });

      console.log('✅ Média local obtenu:', {
        videoTracks: stream.getVideoTracks().length,
        audioTracks: stream.getAudioTracks().length
      });

      applyLocalStream(stream);
      return stream;
    } catch (err) {
      // La caméra est parfois déjà accaparée par un autre onglet/appli
      // (fréquent en test avec une seule webcam physique pour deux
      // participants) : on retombe en audio seul plutôt que de bloquer
      // toute la connexion.
      const cameraBusy = ['NotReadableError', 'NotFoundError', 'OverconstrainedError'].includes(err.name);
      if (cameraBusy) {
        console.warn(`⚠️ Caméra indisponible (${err.name}), tentative en audio seul...`);
        try {
          const audioOnlyStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
          console.log('✅ Média local obtenu (audio seul)');
          setIsVideoOn(false);
          setError('Caméra indisponible (déjà utilisée par un autre onglet ou une autre application ?). Rejoint en audio seul.');
          applyLocalStream(audioOnlyStream);
          return audioOnlyStream;
        } catch (audioErr) {
          console.error('❌ Erreur d\'accès au micro:', audioErr);
          setError('Impossible d\'accéder à la caméra ou au micro. Vérifiez les permissions.');
          throw audioErr;
        }
      }

      console.error('❌ Erreur d\'accès aux médias:', err);
      setError('Impossible d\'accéder à la caméra/micro. Vérifiez les permissions.');
      throw err;
    }
  }, [applyLocalStream]);

  /**
   * Rejoindre une réunion
   */
  const joinMeeting = useCallback(async () => {
    try {
      console.log('🚀 Démarrage de la session MediaSoup...');

      // 1. Connexion au serveur
      await connectToServer();

      // 2. Initialiser le média local
      const stream = await initLocalMedia();

      // 3. Rejoindre la salle
      const roomResponse = await joinRoomSocket(meetingId, userName);

      // 4. Charger le device MediaSoup
      await loadDevice();

      if (roomResponse.forceMuted) setIsForceMuted(true);

      // 4.5 Consommer les flux des participants déjà présents dans la salle
      // (sinon on ne voit/entend que ceux qui rejoignent APRÈS nous)
      for (const peer of roomResponse.peers || []) {
        for (const remoteProducer of peer.producers || []) {
          try {
            await consume(remoteProducer.id, peer.peerId, peer.name);
            markRemoteMedia(peer.peerId, remoteProducer.kind, !!remoteProducer.paused);
          } catch (err) {
            console.error(`❌ Erreur consommation flux existant de ${peer.name}:`, err);
          }
        }
      }

      // 5. Créer le transport de production
      await createProducerTransport();

      // 6. Produire audio et vidéo
      if (stream.getVideoTracks().length > 0) {
        await produce('video', stream);
      }
      if (stream.getAudioTracks().length > 0) {
        await produce('audio', stream);

        // Le serveur peut avoir pausé ce producer d'office si l'hôte avait
        // déjà coupé ce micro : on aligne l'interface plutôt que d'afficher un
        // micro ouvert qui n'émet rien.
        if (audioProducerRef.current?.paused) {
          const track = stream.getAudioTracks()[0];
          if (track) track.enabled = false;
          setIsMicOn(false);
        }
      }

      console.log('✅ Réunion rejointe avec succès');
    } catch (err) {
      console.error('❌ Erreur lors de la connexion:', err);
      setError(err.message || 'Erreur lors de la connexion');
    }
  }, [
    meetingId,
    userName,
    connectToServer,
    initLocalMedia,
    joinRoomSocket,
    loadDevice,
    consume,
    createProducerTransport,
    produce,
    markRemoteMedia
  ]);

  /**
   * Quitter une réunion
   */
  const leaveMeeting = useCallback(() => {
    console.log('👋 Départ de la réunion...');

    // Fermer tous les producers
    if (videoProducerRef.current) videoProducerRef.current.close();
    if (audioProducerRef.current) audioProducerRef.current.close();

    // Fermer tous les consumers
    consumersRef.current.forEach(consumer => consumer.close());
    consumersRef.current.clear();

    // Fermer tous les transports
    if (producerTransportRef.current) producerTransportRef.current.close();
    producerTransportRef.current = null;
    if (consumerTransportRef.current) consumerTransportRef.current.close();
    consumerTransportRef.current = null;
    consumerTransportPromiseRef.current = null;

    // Arrêter le stream local (la ref, pas l'état : cette fonction est aussi
    // appelée au démontage du composant, où l'état capturé peut être périmé)
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    localStreamRef.current = null;
    setLocalStream(null);

    // Déconnexion socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    // Réinitialiser les états
    setRemoteStreams({});
    setRemoteMediaState({});
    setIsConnected(false);
    setIsHandRaised(false);
    setRaisedHands({});
    peersRef.current.clear();
    producerOwnersRef.current.clear();
    audioProducerRef.current = null;
    videoProducerRef.current = null;
  }, []);

  /**
   * Couper / rétablir le micro.
   *
   * On met le producer en pause au lieu de le fermer : la coupure est
   * instantanée, les consumers des autres participants restent valides (plus
   * de renégociation à chaque clic), et surtout le serveur diffuse l'état à
   * toute la salle — c'est ce qui permet d'afficher qui est muet, et c'est le
   * même mécanisme que l'hôte utilise pour un mute forcé.
   */
  const setMicEnabled = useCallback(async (enabled) => {
    const stream = localStreamRef.current;
    const producer = audioProducerRef.current;
    const track = stream?.getAudioTracks()[0];

    if (!track || !producer) {
      setIsMicOn(false);
      return;
    }

    if (enabled) {
      track.enabled = true;
      await producer.resume();
      socketRef.current?.emit('resumeProducer', { producerId: producer.id }, (resp) => {
        // Refus possible : l'hôte a coupé ce micro de force.
        if (resp && !resp.success) {
          track.enabled = false;
          producer.pause();
          setIsMicOn(false);
          setIsForceMuted(true);
        }
      });
      setIsMicOn(true);
      console.log('🎤 Micro rallumé');
    } else {
      track.enabled = false;
      await producer.pause();
      socketRef.current?.emit('pauseProducer', { producerId: producer.id });
      setIsMicOn(false);
      console.log('🎤 Micro coupé');
    }
  }, []);

  const toggleMic = useCallback(() => {
    if (isForceMuted && !isMicOn) return; // rallumage interdit par l'hôte
    return setMicEnabled(!isMicOn);
  }, [isMicOn, isForceMuted, setMicEnabled]);

  /**
   * Couper / rétablir la caméra.
   *
   * La piste est bien arrêtée (le voyant de la webcam doit s'éteindre) mais le
   * producer, lui, survit : on lui réinjecte une nouvelle piste via
   * replaceTrack au rallumage. Les autres participants n'ont donc jamais à
   * recréer leur consumer.
   */
  const toggleVideo = useCallback(async () => {
    const stream = localStreamRef.current;
    const producer = videoProducerRef.current;

    if (isVideoOn) {
      try {
        const videoTrack = stream?.getVideoTracks()[0];

        if (producer) {
          await producer.pause();
          socketRef.current?.emit('pauseProducer', { producerId: producer.id });
        }

        if (videoTrack) {
          videoTrack.stop();
          stream.removeTrack(videoTrack);
        }

        setIsVideoOn(false);
        console.log('📹 Webcam arrêtée');
      } catch (err) {
        console.error('❌ Erreur arrêt webcam:', err);
      }
      return;
    }

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      });

      const newVideoTrack = newStream.getVideoTracks()[0];

      const oldTrack = stream?.getVideoTracks()[0];
      if (oldTrack) {
        oldTrack.stop();
        stream.removeTrack(oldTrack);
      }
      stream?.addTrack(newVideoTrack);

      if (producer) {
        await producer.replaceTrack({ track: newVideoTrack });
        await producer.resume();
        socketRef.current?.emit('resumeProducer', { producerId: producer.id });
      } else if (producerTransportRef.current) {
        // Cas de la personne entrée en audio seul : premier producer vidéo.
        videoProducerRef.current = await producerTransportRef.current.produce({ track: newVideoTrack });
      }

      setIsVideoOn(true);
      console.log('📹 Webcam rallumée');
    } catch (err) {
      console.error('❌ Erreur rallumage webcam:', err);
      setError('Impossible de rallumer la caméra');
    }
  }, [isVideoOn]);

  /**
   * Démarrer le partage d'écran. Remplace la piste du producer vidéo
   * existant (replaceTrack) plutôt que de créer un second producer : ça
   * évite d'avoir deux pistes vidéo dans le même MediaStream distant (un
   * <video> n'en affiche qu'une de façon fiable). La caméra est mise de
   * côté et restaurée à l'arrêt du partage.
   */
  const startScreenShare = useCallback(async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15 } },
        audio: false,
      });
      const screenTrack = screenStream.getVideoTracks()[0];

      if (videoProducerRef.current) {
        cameraTrackRef.current = localStream?.getVideoTracks()[0] || null;
        await videoProducerRef.current.replaceTrack({ track: screenTrack });

        // Le producer vidéo peut être en pause (caméra coupée avant de
        // partager) : sans reprise, l'écran partagé n'atteindrait personne.
        if (videoProducerRef.current.paused) {
          await videoProducerRef.current.resume();
          socketRef.current?.emit('resumeProducer', { producerId: videoProducerRef.current.id });
        }
      } else {
        // Caméra éteinte : le partage d'écran devient directement le flux vidéo
        const producer = await producerTransportRef.current.produce({ track: screenTrack });
        videoProducerRef.current = producer;
      }

      if (localStream) {
        const oldTrack = localStream.getVideoTracks()[0];
        if (oldTrack) localStream.removeTrack(oldTrack);
        localStream.addTrack(screenTrack);
      }

      // L'utilisateur peut arrêter depuis le bandeau natif du navigateur
      screenTrack.addEventListener('ended', () => stopScreenShare());

      setIsScreenSharing(true);
      setIsVideoOn(true);
      console.log('🖥️ Partage d\'écran démarré');
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        console.error('❌ Erreur partage d\'écran:', err);
        setError('Impossible de démarrer le partage d\'écran');
      }
    }
  }, [localStream]);

  const stopScreenShare = useCallback(async () => {
    if (!isScreenSharing) return;

    try {
      const screenTrack = localStream?.getVideoTracks()[0];
      screenTrack?.stop();

      if (cameraTrackRef.current && cameraTrackRef.current.readyState === 'live') {
        await videoProducerRef.current?.replaceTrack({ track: cameraTrackRef.current });
        if (localStream) {
          if (screenTrack) localStream.removeTrack(screenTrack);
          localStream.addTrack(cameraTrackRef.current);
        }
      } else {
        // La caméra n'était pas active avant le partage : on referme le producer
        const producerId = videoProducerRef.current?.id;
        videoProducerRef.current?.close();
        videoProducerRef.current = null;
        if (producerId) socketRef.current?.emit('closeProducer', { producerId });
        if (localStream && screenTrack) localStream.removeTrack(screenTrack);
        setIsVideoOn(false);
      }

      cameraTrackRef.current = null;
      setIsScreenSharing(false);
      console.log('🖥️ Partage d\'écran arrêté');
    } catch (err) {
      console.error('❌ Erreur arrêt partage d\'écran:', err);
    }
  }, [isScreenSharing, localStream]);

  return {
    localStream,
    remoteStreams,
    remotePeers,
    isMicOn,
    isVideoOn,
    isConnected,
    isScreenSharing,
    isHandRaised,
    raisedHands,
    remoteMediaState,
    isForceMuted,
    error,
    joinMeeting,
    leaveMeeting,
    toggleMic,
    setMicEnabled,
    toggleVideo,
    toggleHand,
    startScreenShare,
    stopScreenShare,
  };
}
