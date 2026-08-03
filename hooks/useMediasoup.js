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

  // Refs (persistent across renders)
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const producerTransportRef = useRef(null);
  const consumerTransportsRef = useRef(new Map()); // peerId -> transport
  const videoProducerRef = useRef(null);
  const audioProducerRef = useRef(null);
  const cameraTrackRef = useRef(null); // piste caméra mise de côté pendant un partage d'écran
  const consumersRef = useRef(new Map()); // consumerId -> consumer
  const peersRef = useRef(new Map()); // peerId -> { peerId, name }

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
    });
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
  const handleNewProducer = useCallback(async ({ producerId, peerId, peerName }) => {
    console.log(`📺 Nouveau producer: ${producerId} de ${peerName} (peerId: ${peerId})`);

    // Ajouter le peer s'il n'existe pas
    if (!peersRef.current.has(peerId)) {
      const info = { peerId, name: peerName };
      peersRef.current.set(peerId, info);
      setRemotePeers(prev => ({ ...prev, [peerId]: info }));
    }

    // Consommer le producer
    // Note: `consume` est déclaré plus bas dans ce fichier — on ne peut pas
    // le référencer dans ce tableau de dépendances (erreur "Cannot access
    // before initialization"). Sa référence est de toute façon stable
    // (dépend uniquement de createConsumerTransport, dont les deps sont []).
    await consume(producerId, peerId, peerName);
  }, []);

  /**
   * Créer un transport de consommation
   */
  const createConsumerTransport = useCallback((peerId) => {
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
      // Créer un consumer transport si nécessaire
      let consumerTransport = consumerTransportsRef.current.get(peerId);

      if (!consumerTransport) {
        consumerTransport = await createConsumerTransport(peerId);
        consumerTransportsRef.current.set(peerId, consumerTransport);
      }

      // Demander au serveur de consommer
      return new Promise((resolve, reject) => {
        socketRef.current.emit('consume', {
          producerId,
          rtpCapabilities: deviceRef.current.rtpCapabilities
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
  }, [createConsumerTransport]);

  /**
   * Gérer la fermeture d'un producer
   */
  const handleProducerClosed = useCallback(({ producerId, peerId }) => {
    console.log(`🚫 Producer fermé: ${producerId} (peerId: ${peerId})`);

    // Trouver et fermer le consumer correspondant
    for (const [consumerId, consumer] of consumersRef.current.entries()) {
      if (consumer.producerId === producerId) {
        consumer.close();
        consumersRef.current.delete(consumerId);
      }
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

    // Fermer le transport de consommation
    const transport = consumerTransportsRef.current.get(peerId);
    if (transport) {
      transport.close();
      consumerTransportsRef.current.delete(peerId);
    }
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

      setLocalStream(stream);
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
          setLocalStream(audioOnlyStream);
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
  }, []);

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

      // 4.5 Consommer les flux des participants déjà présents dans la salle
      // (sinon on ne voit/entend que ceux qui rejoignent APRÈS nous)
      for (const peer of roomResponse.peers || []) {
        for (const producerId of peer.producers || []) {
          try {
            await consume(producerId, peer.peerId, peer.name);
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
    produce
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
    consumerTransportsRef.current.forEach(transport => transport.close());
    consumerTransportsRef.current.clear();

    // Arrêter le stream local
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }

    // Déconnexion socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    // Réinitialiser les états
    setRemoteStreams({});
    setIsConnected(false);
    peersRef.current.clear();
  }, [localStream]);

  /**
   * Toggle micro
   */
  const toggleMic = useCallback(async () => {
    if (isMicOn && audioProducerRef.current) {
      // Arrêter le micro
      const producerId = audioProducerRef.current.id;
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.stop();
        localStream.removeTrack(audioTrack);
      }

      audioProducerRef.current.close();
      audioProducerRef.current = null;

      // Prévenir le serveur pour qu'il notifie les autres participants
      // (sinon leur consumer garde une référence morte côté client)
      socketRef.current?.emit('closeProducer', { producerId });

      setIsMicOn(false);
      console.log('🎤 Micro arrêté');
    } else {
      // Rallumer le micro
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        const newAudioTrack = newStream.getAudioTracks()[0];

        // Remplacer le track dans le stream local
        const oldTrack = localStream.getAudioTracks()[0];
        if (oldTrack) {
          localStream.removeTrack(oldTrack);
        }
        localStream.addTrack(newAudioTrack);

        // Re-produire l'audio
        const producer = await producerTransportRef.current.produce({ track: newAudioTrack });
        audioProducerRef.current = producer;

        producer.on('trackended', () => {
          console.log('Track audio terminé');
        });

        producer.on('transportclose', () => {
          console.log('Transport fermé pour audio');
        });

        setIsMicOn(true);
        console.log('🎤 Micro rallumé');
      } catch (err) {
        console.error('❌ Erreur rallumage micro:', err);
        setError('Impossible de rallumer le micro');
      }
    }
  }, [isMicOn, localStream]);

  /**
   * Toggle vidéo
   */
  const toggleVideo = useCallback(async () => {
    if (isVideoOn && videoProducerRef.current) {
      // Arrêter la webcam
      const producerId = videoProducerRef.current.id;
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        localStream.removeTrack(videoTrack);
      }

      // Fermer le producer
      videoProducerRef.current.close();
      videoProducerRef.current = null;

      // Prévenir le serveur pour qu'il notifie les autres participants
      // (sinon leur consumer garde une référence morte côté client)
      socketRef.current?.emit('closeProducer', { producerId });

      setIsVideoOn(false);
      console.log('📹 Webcam arrêtée');
    } else {
      // Rallumer la webcam
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          }
        });

        const newVideoTrack = newStream.getVideoTracks()[0];

        // Remplacer le track dans le stream local
        const oldTrack = localStream.getVideoTracks()[0];
        if (oldTrack) {
          localStream.removeTrack(oldTrack);
        }
        localStream.addTrack(newVideoTrack);

        // Re-produire la vidéo
        const producer = await producerTransportRef.current.produce({ track: newVideoTrack });
        videoProducerRef.current = producer;

        producer.on('trackended', () => {
          console.log('Track vidéo terminé');
        });

        producer.on('transportclose', () => {
          console.log('Transport fermé pour vidéo');
        });

        setIsVideoOn(true);
        console.log('📹 Webcam rallumée');
      } catch (err) {
        console.error('❌ Erreur rallumage webcam:', err);
        setError('Impossible de rallumer la caméra');
      }
    }
  }, [isVideoOn, localStream]);

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
    error,
    joinMeeting,
    leaveMeeting,
    toggleMic,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
  };
}
