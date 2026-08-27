/**
 * Hook useMediasoup - Client MediaSoup
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import * as mediasoupClient from 'mediasoup-client';
import io from 'socket.io-client';

const MEDIASOUP_SERVER_URL = process.env.NEXT_PUBLIC_MEDIASOUP_URL || 'http://localhost:3001';

// Contraintes de capture, définies une seule fois : elles étaient recopiées
// dans `initLocalMedia` et dans `toggleVideo`, et les deux copies avaient
// commencé à diverger.
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

// Une consommation de flux qui echoue etait definitivement perdue : le
// participant restait invisible pour toute la reunion. Trois tentatives
// couvrent les echecs passagers (aller-retour reseau perdu, transport pas
// encore pret, bascule 4G/Wi-Fi d'un telephone).
const CONSUME_ATTEMPTS = 3;
const CONSUME_RETRY_MS = 600;

// Filet de securite : meme avec les tentatives, un flux peut manquer a
// l'appel. On compare periodiquement ce que le serveur heberge a ce qu'on a
// reellement recu, et on redemande la difference. Meme principe que la
// resynchronisation de la liste des participants — le socket fait tout le
// travail en temps normal, ceci ne rattrape que les trous.
const RECONCILE_STREAMS_MS = 8000;

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

/**
 * Contraintes visant un périphérique précis.
 *
 * `ideal` plutôt qu'`exact` : un périphérique débranché entre la sélection et
 * la capture ferait échouer un `exact` avec `OverconstrainedError`, alors
 * qu'`ideal` retombe simplement sur le périphérique par défaut.
 */
function withDevice(base, deviceId) {
  return deviceId ? { ...base, deviceId: { ideal: deviceId } } : { ...base };
}

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
  const [remoteScreenShares, setRemoteScreenShares] = useState({}); // peerId -> bool
  const [isForceMuted, setIsForceMuted] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  // Périphériques réellement utilisés. Ils sont renseignés depuis les pistes
  // obtenues (et non depuis ce que l'utilisateur a choisi) : le navigateur
  // peut retenir un autre appareil que celui demandé.
  const [audioInputId, setAudioInputId] = useState(null);
  const [videoInputId, setVideoInputId] = useState(null);
  const [audioOutputId, setAudioOutputId] = useState(null);
  // Camera avant ('user') ou arriere ('environment'). Sur ordinateur la notion
  // n'existe pas : la valeur reste nulle et le bouton de bascule est masque.
  const [facingMode, setFacingMode] = useState(null);
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);

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
  // Choix de périphériques mémorisés, à réappliquer à chaque capture : rallumer
  // la caméra ou se reconnecter après une coupure doit reprendre l'appareil
  // choisi, pas revenir au défaut du système.
  const preferredAudioInputRef = useRef(null);
  const preferredVideoInputRef = useRef(null);
  // Sur telephone on vise une orientation de camera, pas un identifiant : les
  // deux s'excluent, choisir l'un efface l'autre.
  const preferredFacingRef = useRef(null);
  const consumersRef = useRef(new Map()); // consumerId -> consumer
  const peersRef = useRef(new Map()); // peerId -> { peerId, name }
  const producerOwnersRef = useRef(new Map()); // producerId distant -> { peerId, kind }
  // Producers dont la consommation est en cours. Sans ce garde-fou, la
  // reconciliation relancerait une consommation deja partie et le serveur
  // creerait deux consumers pour le meme flux.
  const consumingRef = useRef(new Set());

  // Le stream local est aussi gardé en ref : les callbacks mémoïsés
  // (toggleMic, toggleVideo…) sont recréés à chaque changement de
  // `localStream`, et un handler socket enregistré une seule fois au montage
  // lirait sinon un stream périmé.
  const localStreamRef = useRef(null);

  // Refs de reconnexion. `hasJoinedRef` distingue la première connexion des
  // suivantes : socket.io émet `connect` dans les deux cas.
  const hasJoinedRef = useRef(false);
  const rejoiningRef = useRef(false);
  const establishSessionRef = useRef(null);
  // Les signaux éphémères doivent être réémis après une coupure ; on les lit
  // par ref car le gestionnaire `connect` est enregistré une seule fois et
  // capturerait sinon des états périmés.
  const screenSharingRef = useRef(false);
  const handRaisedRef = useRef(false);
  screenSharingRef.current = isScreenSharing;
  handRaisedRef.current = isHandRaised;
  // Le gestionnaire de reprise de partage est enregistre une seule fois au
  // montage : il ne peut pas capturer `stopScreenShare`, defini bien plus bas
  // et recree a chaque changement de flux.
  const stopScreenShareRef = useRef(null);

  // Serveurs ICE (STUN/TURN), récupérés du serveur avec des identifiants
  // temporaires. Sans eux, un participant derrière un NAT strict ou un réseau
  // d'entreprise ne peut pas joindre le SFU du tout.
  const iceServersRef = useRef([]);

  const applyLocalStream = useCallback((stream) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // Y a-t-il de quoi basculer ? Les libelles et le nombre de cameras ne sont
  // exposes qu'une fois l'autorisation accordee, d'où l'attente du flux local.
  // Un ordinateur portable avec une webcam externe branchee compte deux
  // cameras : le bouton lui sert aussi.
  useEffect(() => {
    if (!localStream || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    let cancelled = false;

    const countCameras = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setHasMultipleCameras(devices.filter((d) => d.kind === 'videoinput').length > 1);
      } catch {
        // Enumeration refusee : on laisse le bouton masque.
      }
    };

    countCameras();
    navigator.mediaDevices.addEventListener?.('devicechange', countCameras);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.('devicechange', countCameras);
    };
  }, [localStream]);

  // Le partage d'écran n'existe pas sur mobile : le bouton doit le refléter
  // plutôt que de proposer une action vouée à échouer.
  const canShareScreen =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  /**
   * Ferme tous les objets mediasoup du client, sans toucher au flux local ni au
   * socket. Appelé avant de rejouer une session après reconnexion : côté
   * serveur, le peer a été détruit à la déconnexion, donc les transports,
   * producers et consumers d'avant ne correspondent plus à rien.
   *
   * Déclaré ici, avant `connectToServer`, parce que le gestionnaire de
   * reconnexion s'en sert — le référencer plus bas provoquerait une erreur de
   * portée à l'évaluation du tableau de dépendances.
   */
  const resetMediaSession = useCallback(() => {
    videoProducerRef.current?.close();
    audioProducerRef.current?.close();
    videoProducerRef.current = null;
    audioProducerRef.current = null;

    consumersRef.current.forEach((consumer) => consumer.close());
    consumersRef.current.clear();

    producerTransportRef.current?.close();
    producerTransportRef.current = null;
    consumerTransportRef.current?.close();
    consumerTransportRef.current = null;
    consumerTransportPromiseRef.current = null;

    // Le device doit être rechargé : si la salle s'était vidée entre-temps, le
    // router a été fermé et recréé, avec de nouvelles capacités RTP.
    deviceRef.current = null;

    producerOwnersRef.current.clear();
    consumingRef.current.clear();
    peersRef.current.clear();
    setRemoteStreams({});
    setRemotePeers({});
    setRemoteMediaState({});
    setRemoteScreenShares({});
  }, []);

  /**
   * Récupère les serveurs ICE. Les identifiants TURN expirent, donc on les
   * redemande à chaque établissement de session — y compris après une
   * reconnexion, où ceux d'avant peuvent être périmés.
   *
   * Un échec n'est pas bloquant : on repart en connexion directe, ce qui suffit
   * à la grande majorité des réseaux.
   */
  const loadIceServers = useCallback(async () => {
    try {
      const response = await fetch('/api/turn', { cache: 'no-store' });
      const data = await response.json();
      iceServersRef.current = data.iceServers || [];
      console.log(`🧊 ${iceServersRef.current.length} serveur(s) ICE chargé(s)`);
    } catch (err) {
      console.warn('⚠️ Serveurs ICE indisponibles, connexion directe uniquement:', err);
      iceServersRef.current = [];
    }
  }, []);

  /**
   * Options ICE communes aux deux transports.
   *
   * `?forceRelay` dans l'URL impose le passage par TURN. Indispensable pour le
   * tester : sur son propre réseau, ICE choisira toujours le chemin direct, et
   * on ne saurait jamais si le relais fonctionne avant qu'un utilisateur
   * réellement bloqué ne se plaigne.
   */
  const iceOptions = useCallback(() => {
    const forceRelay =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('forceRelay');

    return {
      iceServers: iceServersRef.current,
      ...(forceRelay ? { iceTransportPolicy: 'relay' } : {}),
    };
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

        // Reconnexion après coupure réseau. Le serveur a détruit le peer à la
        // déconnexion (`cleanupPeer`), et ce socket porte un nouvel
        // identifiant : sans rejouer l'adhésion, l'interface afficherait
        // « connecté » alors que la personne est sortie de la réunion — une
        // panne silencieuse, pire qu'un échec franc.
        // `localStreamRef` sert de garde : après un départ volontaire le flux
        // est libéré, et il n'y a plus rien à reconstruire.
        if (hasJoinedRef.current && !rejoiningRef.current && localStreamRef.current) {
          rejoiningRef.current = true;
          setIsReconnecting(true);

          (async () => {
            try {
              console.log('🔄 Reconnexion : reconstruction de la session…');
              resetMediaSession();
              await establishSessionRef.current?.(localStreamRef.current);
              console.log('✅ Session reconstruite');
              setError(null);
            } catch (err) {
              console.error('❌ Reconstruction de session impossible:', err);
              setError('La reconnexion a échoué. Rechargez la page pour revenir dans la réunion.');
            } finally {
              rejoiningRef.current = false;
              setIsReconnecting(false);
            }
          })();
        }

        resolve();
      });

      socketRef.current.on('disconnect', () => {
        console.log('❌ Déconnecté du serveur');
        setIsConnected(false);
        // Signalé dès la coupure, pas seulement au retour : c'est pendant
        // l'interruption que l'utilisateur a besoin de comprendre le silence.
        if (hasJoinedRef.current) setIsReconnecting(true);
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
      socketRef.current.on('peer-screen-share', handlePeerScreenShare);
      socketRef.current.on('screen-share-revoked', handleScreenShareRevoked);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetMediaSession]);

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
          producerTransportRef.current = deviceRef.current.createSendTransport({
            ...response.params,
            ...iceOptions(),
          });

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
  }, [iceOptions]);

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
          const consumerTransport = deviceRef.current.createRecvTransport({
            ...response.params,
            ...iceOptions(),
          });

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
  }, [iceOptions]);

  /**
   * Consommer un producer distant
   */
  /**
   * Attendre que le device mediasoup soit charge. Il est nul entre la
   * connexion du socket et `getRtpCapabilities`, et de nouveau pendant une
   * reconnexion — deux fenetres pendant lesquelles un `new-producer` peut
   * arriver.
   */
  const waitForDevice = useCallback(async (timeoutMs = 8000) => {
    const startedAt = Date.now();
    while (!deviceRef.current) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Device mediasoup indisponible');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, []);

  const consumeOnce = useCallback(async (producerId, peerId, peerName) => {
    try {
      // Le device peut ne pas etre encore charge : les gestionnaires socket
      // sont poses des la connexion, alors que le device n'existe qu'apres
      // `getRtpCapabilities`, et il repasse a nul pendant une reconnexion.
      // Lire `deviceRef.current.rtpCapabilities` a l'aveugle levait alors une
      // TypeError, avalee plus bas — et le participant disparaissait.
      await waitForDevice();

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
      // Volontairement propagee : c'est `consume` qui decide de reessayer.
      // L'avaler ici perdait le participant pour toute la reunion.
      throw err;
    }
  }, [createConsumerTransport, markRemoteMedia, waitForDevice]);

  /**
   * Consommer un flux distant, avec reprise.
   *
   * Un echec passager — aller-retour perdu, transport pas encore etabli,
   * telephone qui bascule de reseau — laissait auparavant ce participant sans
   * tuile jusqu'a la fin de la reunion, sans rien afficher. La seule trace
   * etait une ligne rouge dans la console.
   */
  const consume = useCallback(async (producerId, peerId, peerName) => {
    if (producerOwnersRef.current.has(producerId)) return;
    if (consumingRef.current.has(producerId)) return;
    consumingRef.current.add(producerId);

    try {
      for (let attempt = 1; attempt <= CONSUME_ATTEMPTS; attempt += 1) {
        try {
          await consumeOnce(producerId, peerId, peerName);
          return;
        } catch (err) {
          if (attempt === CONSUME_ATTEMPTS) {
            console.error(`❌ Flux de ${peerName} irrecuperable apres ${attempt} tentatives:`, err);
            // Pas de message a l'utilisateur : la reconciliation periodique
            // reessaiera d'elle-meme, et une alerte pour un incident qui se
            // repare en huit secondes ferait plus de bruit que de bien.
            return;
          }
          console.warn(`⚠️ Consommation du flux de ${peerName} echouee (essai ${attempt}), nouvelle tentative…`);
          await new Promise((resolve) => setTimeout(resolve, CONSUME_RETRY_MS * attempt));
        }
      }
    } finally {
      consumingRef.current.delete(producerId);
    }
  }, [consumeOnce]);

  /**
   * Rattraper les flux manquants.
   *
   * `new-producer` n'est emis qu'une fois : si on le rate, ou si la
   * consommation echoue jusqu'au bout de ses tentatives, ce participant reste
   * invisible pour le reste de la reunion. C'est ce qui produisait le symptome
   * observe — trois personnes dans la liste, deux tuiles a l'ecran, et un
   * client sur deux touche au hasard.
   *
   * On demande donc regulierement au serveur l'inventaire des flux de la salle
   * et on consomme ce qui manque. Sans effet quand tout va bien : le filtre ne
   * retient rien.
   */
  const reconcileStreams = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected || !hasJoinedRef.current || !deviceRef.current) return;

    socket.emit('list-producers', (response) => {
      if (!response?.success) return;

      const missing = (response.producers || []).filter(
        (p) => !producerOwnersRef.current.has(p.producerId) && !consumingRef.current.has(p.producerId)
      );
      if (missing.length === 0) return;

      console.warn(`🔁 ${missing.length} flux manquant(s), nouvelle tentative de consommation`);
      missing.forEach((p) => {
        // Le peer peut nous être inconnu si on a aussi rate son `peer-joined`.
        if (!peersRef.current.has(p.peerId)) {
          const info = { peerId: p.peerId, name: p.peerName };
          peersRef.current.set(p.peerId, info);
          setRemotePeers((prev) => ({ ...prev, [p.peerId]: info }));
        }
        consume(p.producerId, p.peerId, p.peerName);
      });
    });
  }, [consume]);

  // La reconciliation tourne tant qu'on est en salle. Elle est aussi declenchee
  // juste apres l'etablissement de la session, ou la fenetre de rattrapage est
  // la plus utile : c'est la que les flux affluent tous en meme temps.
  const reconcileStreamsRef = useRef(null);
  reconcileStreamsRef.current = reconcileStreams;

  useEffect(() => {
    if (!isConnected) return;
    const interval = setInterval(() => reconcileStreamsRef.current?.(), RECONCILE_STREAMS_MS);
    return () => clearInterval(interval);
  }, [isConnected]);

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

    setRemoteScreenShares(prev => {
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

  /** Un participant distant a commencé ou arrêté de partager son écran. */
  /**
   * Quelqu'un d'autre a pris le partage d'ecran : le serveur n'autorise qu'une
   * presentation a la fois. On rend la camera et on l'annonce — sans message,
   * l'ecran cesserait d'etre diffuse sans que personne ne sache pourquoi.
   */
  const handleScreenShareRevoked = useCallback(({ byName }) => {
    stopScreenShareRef.current?.();
    setError(`${byName || 'Un participant'} a pris le partage d'ecran.`);
  }, []);

  const handlePeerScreenShare = useCallback(({ peerId, sharing }) => {
    setRemoteScreenShares(prev => ({ ...prev, [peerId]: !!sharing }));
  }, []);

  /**
   * Lever/baisser ma propre main — signal éphémère relayé aux autres via
   * Mediasoup (pas de persistance en base, comme le mic/la caméra).
   */
  const toggleHand = useCallback(() => {
    setIsHandRaised(prev => {
      const next = !prev;
      socketRef.current?.emit('toggle-hand', { raised: next });

      // Se référencer soi-même dans `raisedHands` : cette table ne contenait
      // que les participants distants, si bien qu'on ne voyait jamais sa
      // propre main levée — ni sur sa tuile, ni dans la liste des
      // participants. Une seule table pour tout le monde.
      if (userId) setRaisedHands(hands => ({ ...hands, [userId]: next }));

      return next;
    });
  }, [userId]);

  /**
   * Contraintes de capture video du moment.
   *
   * Un identifiant de peripherique est plus precis qu'une orientation : quand
   * l'utilisateur a explicitement choisi une camera dans les reglages, ce choix
   * prime sur la bascule avant/arriere.
   */
  const videoCapture = useCallback(() => {
    if (preferredVideoInputRef.current) {
      return withDevice(VIDEO_CONSTRAINTS, preferredVideoInputRef.current);
    }
    if (preferredFacingRef.current) {
      return { ...VIDEO_CONSTRAINTS, facingMode: { ideal: preferredFacingRef.current } };
    }
    return { ...VIDEO_CONSTRAINTS };
  }, []);

  /**
   * Retenir les périphériques effectivement retenus par le navigateur.
   *
   * `getSettings().deviceId` dit ce qui a réellement été ouvert, ce qui n'est
   * pas toujours ce qu'on avait demandé — appareil débranché, contrainte
   * assouplie. C'est cette valeur que doit refléter le sélecteur, sans quoi il
   * afficherait un périphérique qui ne sert pas.
   */
  const rememberActiveDevices = useCallback((stream) => {
    const audioDeviceId = stream?.getAudioTracks()[0]?.getSettings?.().deviceId || null;
    const videoDeviceId = stream?.getVideoTracks()[0]?.getSettings?.().deviceId || null;

    if (audioDeviceId) {
      preferredAudioInputRef.current = audioDeviceId;
      setAudioInputId(audioDeviceId);
    }
    if (videoDeviceId) {
      preferredVideoInputRef.current = videoDeviceId;
      setVideoInputId(videoDeviceId);
    }

    // `facingMode` n'est renseigne que par les navigateurs mobiles ; sur
    // ordinateur il reste absent, ce qui suffit a masquer le bouton.
    const facing = stream?.getVideoTracks()[0]?.getSettings?.().facingMode || null;
    setFacingMode(facing);
    if (facing) preferredFacingRef.current = facing;
  }, []);

  /**
   * Initialiser le média local (caméra et micro)
   */
  const initLocalMedia = useCallback(async () => {
    const audioConstraints = withDevice(AUDIO_CONSTRAINTS, preferredAudioInputRef.current);
    const videoConstraints = videoCapture();

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

      rememberActiveDevices(stream);
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
          rememberActiveDevices(audioOnlyStream);
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
  }, [applyLocalStream, rememberActiveDevices, videoCapture]);

  /**
   * Préparer l'aperçu local, sans rien connecter.
   *
   * Le lobby doit montrer sa caméra et laisser régler micro/caméra AVANT
   * d'entrer dans la salle : impossible si l'obtention du média est soudée à la
   * connexion au serveur. D'où cette étape séparée, dont `joinMeeting`
   * réutilise ensuite le flux au lieu de redemander l'accès aux périphériques.
   */
  const initPreview = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    return initLocalMedia();
  }, [initLocalMedia]);

  /**
   * Établit la session dans la salle à partir d'un flux local déjà obtenu :
   * adhésion, chargement du device, consommation des flux présents, création du
   * transport d'émission et production.
   *
   * Extrait de `joinMeeting` pour être rejouable tel quel après une coupure
   * réseau — c'est exactement la séquence qu'il faut refaire, et la dupliquer
   * garantirait qu'une des deux copies dérive.
   */
  const establishSession = useCallback(async (stream) => {
    // Avant tout transport : les identifiants TURN sont datés, il faut des
    // frais — en particulier après une reconnexion tardive.
    await loadIceServers();

    const roomResponse = await joinRoomSocket(meetingId, userName);

    await loadDevice();

    if (roomResponse.forceMuted) setIsForceMuted(true);

    // Consommer les flux des participants déjà présents dans la salle
    // (sinon on ne voit/entend que ceux qui rejoignent APRÈS nous)
    for (const peer of roomResponse.peers || []) {
      if (peer.sharingScreen) {
        setRemoteScreenShares((prev) => ({ ...prev, [peer.peerId]: true }));
      }
      for (const remoteProducer of peer.producers || []) {
        try {
          await consume(remoteProducer.id, peer.peerId, peer.name);
          markRemoteMedia(peer.peerId, remoteProducer.kind, !!remoteProducer.paused);
        } catch (err) {
          console.error(`❌ Erreur consommation flux existant de ${peer.name}:`, err);
        }
      }
    }

    await createProducerTransport();

    if (stream.getVideoTracks().length > 0) {
      await produce('video', stream);
    }

    if (stream.getAudioTracks().length > 0) {
      await produce('audio', stream);

      const audioTrack = stream.getAudioTracks()[0];

      // Micro coupé (dans le lobby, ou avant la coupure réseau) : la piste est
      // désactivée mais le producer vient d'être créé actif. Sans cette mise en
      // pause, on entrerait en émettant alors que l'interface affiche « coupé ».
      if (audioTrack && !audioTrack.enabled && audioProducerRef.current) {
        await audioProducerRef.current.pause();
        socketRef.current?.emit('pauseProducer', { producerId: audioProducerRef.current.id });
        setIsMicOn(false);
      }

      // Le serveur peut aussi avoir pausé ce producer d'office si l'hôte avait
      // déjà coupé ce micro : on aligne l'interface plutôt que d'afficher un
      // micro ouvert qui n'émet rien.
      if (audioProducerRef.current?.paused) {
        if (audioTrack) audioTrack.enabled = false;
        setIsMicOn(false);
      }
    }

    // Signaux éphémères à réémettre : le serveur les a oubliés avec le peer.
    // Sans ça, une main levée disparaîtrait chez les autres après une coupure,
    // et un partage d'écran serait affiché rogné comme une caméra.
    if (screenSharingRef.current) {
      socketRef.current?.emit('screen-share', { sharing: true });
    }
    if (handRaisedRef.current) {
      socketRef.current?.emit('toggle-hand', { raised: true });
    }

    // Rattrapage immediat : c'est ici que la fenetre est la plus a risque, tous
    // les flux de la salle arrivant en meme temps. Differe d'une seconde pour
    // laisser les consommations normales aboutir et ne rien redemander pour
    // rien.
    setTimeout(() => reconcileStreamsRef.current?.(), 1000);
  }, [
    meetingId,
    userName,
    joinRoomSocket,
    loadDevice,
    consume,
    createProducerTransport,
    produce,
    markRemoteMedia,
    loadIceServers,
  ]);

  // Le gestionnaire `connect` est enregistré une seule fois et capturerait une
  // version périmée d'`establishSession` ; il passe donc par cette ref.
  establishSessionRef.current = establishSession;

  /**
   * Rejoindre une réunion.
   */
  const joinMeeting = useCallback(async () => {
    try {
      console.log('🚀 Démarrage de la session MediaSoup...');

      await connectToServer();

      // Média local — déjà obtenu si l'on passe par le lobby.
      const stream = localStreamRef.current || await initLocalMedia();

      await establishSession(stream);

      hasJoinedRef.current = true;
      console.log('✅ Réunion rejointe avec succès');
      // Renvoie l'issue plutôt que de laisser l'appelant inspecter `error` :
      // cet état ne serait pas encore à jour dans sa closure au retour du await.
      return true;
    } catch (err) {
      console.error('❌ Erreur lors de la connexion:', err);
      setError(err.message || 'Erreur lors de la connexion');
      return false;
    }
  }, [connectToServer, initLocalMedia, establishSession]);

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

    // Départ volontaire : plus aucune reconnexion ne doit tenter de
    // reconstruire la session.
    hasJoinedRef.current = false;
    rejoiningRef.current = false;
    setIsReconnecting(false);

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

    if (!track) {
      setIsMicOn(false);
      return;
    }

    // Avant d'avoir rejoint (aperçu du lobby), il n'existe aucun producer :
    // on se contente d'activer ou de couper la piste. L'état choisi ici est
    // ensuite repris au moment de rejoindre.
    if (!producer) {
      track.enabled = enabled;
      setIsMicOn(enabled);
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
        video: videoCapture(),
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

      rememberActiveDevices(stream);
      setIsVideoOn(true);
      console.log('📹 Webcam rallumée');
    } catch (err) {
      console.error('❌ Erreur rallumage webcam:', err);
      setError('Impossible de rallumer la caméra');
    }
  }, [isVideoOn, rememberActiveDevices, videoCapture]);

  /**
   * Démarrer le partage d'écran. Remplace la piste du producer vidéo
   * existant (replaceTrack) plutôt que de créer un second producer : ça
   * évite d'avoir deux pistes vidéo dans le même MediaStream distant (un
   * <video> n'en affiche qu'une de façon fiable). La caméra est mise de
   * côté et restaurée à l'arrêt du partage.
   */
  const startScreenShare = useCallback(async () => {
    // Safari iOS et la plupart des navigateurs mobiles n'implémentent tout
    // simplement pas getDisplayMedia : mieux vaut l'annoncer que laisser
    // l'appel échouer sur une erreur technique incompréhensible.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      setError("Le partage d'écran n'est pas disponible sur ce navigateur. Essayez depuis un ordinateur.");
      return;
    }

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

      socketRef.current?.emit('screen-share', { sharing: true });
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
      socketRef.current?.emit('screen-share', { sharing: false });
      setIsScreenSharing(false);
      console.log('🖥️ Partage d\'écran arrêté');
    } catch (err) {
      console.error('❌ Erreur arrêt partage d\'écran:', err);
    }
  }, [isScreenSharing, localStream]);

  stopScreenShareRef.current = stopScreenShare;

  /**
   * Changer de microphone en cours de réunion.
   *
   * La nouvelle piste remplace l'ancienne dans le producer (`replaceTrack`) :
   * les consumers des autres participants restent valides, personne n'entend
   * de coupure. L'ancienne version se contentait d'ouvrir un flux puis de le
   * refermer aussitôt — le choix n'était jamais appliqué nulle part.
   *
   * @returns {Promise<boolean>} vrai si le micro a bien changé
   */
  const switchAudioInput = useCallback(async (deviceId) => {
    const stream = localStreamRef.current;
    if (!stream) return false;

    const previousTrack = stream.getAudioTracks()[0] || null;
    // On demande le nouveau périphérique AVANT de lâcher l'ancien : si la
    // capture échoue, la personne reste audible avec son micro actuel.
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: withDevice(AUDIO_CONSTRAINTS, deviceId),
      });
    } catch (err) {
      console.error('❌ Micro indisponible:', err);
      setError("Ce microphone est indisponible. L'ancien reste actif.");
      return false;
    }

    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return false;

    // Le micro coupé doit le rester : sans ça, changer de périphérique
    // rouvrirait le micro de quelqu'un que l'hôte vient de faire taire.
    newTrack.enabled = previousTrack ? previousTrack.enabled : isMicOn;

    try {
      if (audioProducerRef.current) {
        await audioProducerRef.current.replaceTrack({ track: newTrack });
      }
      if (previousTrack) {
        previousTrack.stop();
        stream.removeTrack(previousTrack);
      }
      stream.addTrack(newTrack);

      preferredAudioInputRef.current = deviceId || null;
      rememberActiveDevices(stream);
      console.log('🎤 Microphone changé');
      return true;
    } catch (err) {
      console.error('❌ Changement de micro impossible:', err);
      newTrack.stop();
      setError('Changement de microphone impossible.');
      return false;
    }
  }, [isMicOn, rememberActiveDevices]);

  /**
   * Changer de caméra en cours de réunion.
   *
   * Deux cas n'ouvrent aucun flux : caméra éteinte (le choix est simplement
   * mémorisé pour le prochain allumage) et partage d'écran en cours (le
   * producer vidéo porte l'écran, pas le visage).
   *
   * @returns {Promise<boolean>} vrai si le changement est appliqué maintenant
   */
  const switchVideoInput = useCallback(async (deviceId) => {
    const stream = localStreamRef.current;
    if (!stream) return false;

    const previousPreference = preferredVideoInputRef.current;
    preferredVideoInputRef.current = deviceId || null;
    // Choix explicite d'une camera : l'orientation memorisee n'a plus cours.
    preferredFacingRef.current = null;

    // Deux cas n'ouvrent rien maintenant : le choix est retenu, et c'est déjà
    // le bon état à afficher.
    if (screenSharingRef.current) {
      setVideoInputId(deviceId || null);
      setError("La caméra changera à la fin du partage d'écran.");
      return true;
    }
    if (!isVideoOn) {
      setVideoInputId(deviceId || null);
      return true;
    }

    const previousTrack = stream.getVideoTracks()[0] || null;
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: withDevice(VIDEO_CONSTRAINTS, deviceId),
      });
    } catch (err) {
      // La caméra d'avant tourne toujours : la préférence doit revenir sur
      // elle, sinon le prochain allumage viserait un appareil qui a échoué.
      preferredVideoInputRef.current = previousPreference;
      console.error('❌ Caméra indisponible:', err);
      setError("Cette caméra est indisponible. L'ancienne reste active.");
      return false;
    }

    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) {
      preferredVideoInputRef.current = previousPreference;
      return false;
    }

    try {
      if (videoProducerRef.current) {
        await videoProducerRef.current.replaceTrack({ track: newTrack });
      } else if (producerTransportRef.current) {
        videoProducerRef.current = await producerTransportRef.current.produce({ track: newTrack });
      }
      if (previousTrack) {
        previousTrack.stop();
        stream.removeTrack(previousTrack);
      }
      stream.addTrack(newTrack);

      rememberActiveDevices(stream);
      console.log('📹 Caméra changée');
      return true;
    } catch (err) {
      preferredVideoInputRef.current = previousPreference;
      console.error('❌ Changement de caméra impossible:', err);
      newTrack.stop();
      setError('Changement de caméra impossible.');
      return false;
    }
  }, [isVideoOn, rememberActiveDevices]);

  /**
   * Basculer entre la camera avant et la camera arriere.
   *
   * C'est le contrôle mobile le plus utilise, et il n'existait pas : on ne
   * pouvait montrer ni un tableau, ni un document, ni un ecran physique. C'est
   * aussi la seule forme de « presentation » possible depuis un telephone,
   * puisque aucun navigateur mobile n'implemente la capture d'ecran.
   *
   * On raisonne en orientation (`facingMode`) et non en identifiant de
   * peripherique : sur Android, un telephone expose parfois quatre cameras
   * arriere, dont on ne sait pas laquelle est la principale. Le systeme, lui,
   * le sait.
   *
   * @returns {Promise<boolean>}
   */
  const switchCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return false;

    if (screenSharingRef.current) {
      setError("Arretez le partage d'ecran avant de changer de camera.");
      return false;
    }

    const current = preferredFacingRef.current
      || stream.getVideoTracks()[0]?.getSettings?.().facingMode
      || 'user';
    const next = current === 'environment' ? 'user' : 'environment';

    const previousFacing = preferredFacingRef.current;
    const previousDevice = preferredVideoInputRef.current;
    // L'identifiant fige la camera : tant qu'il est pose, l'orientation
    // demandee serait ignoree.
    preferredVideoInputRef.current = null;
    preferredFacingRef.current = next;

    const restore = () => {
      preferredFacingRef.current = previousFacing;
      preferredVideoInputRef.current = previousDevice;
    };

    // Camera coupee : le choix est retenu, `toggleVideo` s'en servira.
    if (!isVideoOn) {
      setFacingMode(next);
      return true;
    }

    const previousTrack = stream.getVideoTracks()[0] || null;
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: { ...VIDEO_CONSTRAINTS, facingMode: { ideal: next } },
      });
    } catch (err) {
      restore();
      console.error('Camera indisponible:', err);
      setError("Impossible d'acceder a cette camera.");
      return false;
    }

    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) {
      restore();
      return false;
    }

    try {
      if (videoProducerRef.current) {
        await videoProducerRef.current.replaceTrack({ track: newTrack });
      } else if (producerTransportRef.current) {
        videoProducerRef.current = await producerTransportRef.current.produce({ track: newTrack });
      }
      if (previousTrack) {
        previousTrack.stop();
        stream.removeTrack(previousTrack);
      }
      stream.addTrack(newTrack);

      rememberActiveDevices(stream);
      // Le navigateur peut avoir servi autre chose que ce qu'on visait
      // (`ideal`) : c'est l'etat reel qui doit s'afficher. `rememberActiveDevices`
      // repose `preferredVideoInputRef`, on l'efface pour que la prochaine
      // bascule reste pilotee par l'orientation.
      preferredVideoInputRef.current = null;
      preferredFacingRef.current =
        newTrack.getSettings?.().facingMode || next;
      setFacingMode(preferredFacingRef.current);
      return true;
    } catch (err) {
      restore();
      console.error('Bascule de camera impossible:', err);
      newTrack.stop();
      setError('Bascule de camera impossible.');
      return false;
    }
  }, [isVideoOn, rememberActiveDevices]);

  /**
   * Choisir la sortie audio (casque, enceintes). Le hook ne fait que retenir
   * le choix : c'est chaque balise `<audio>` de tuile qui appelle `setSinkId`,
   * puisque le son sort d'elles et non d'un objet central.
   */
  const selectAudioOutput = useCallback((deviceId) => {
    setAudioOutputId(deviceId || null);
  }, []);

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
    remoteScreenShares,
    isForceMuted,
    isReconnecting,
    error,
    clearError,
    canShareScreen,
    audioInputId,
    videoInputId,
    audioOutputId,
    facingMode,
    hasMultipleCameras,
    switchCamera,
    switchAudioInput,
    switchVideoInput,
    selectAudioOutput,
    initPreview,
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
