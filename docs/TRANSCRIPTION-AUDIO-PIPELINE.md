# Comment l'audio circule réellement, du navigateur au modèle

Note technique complémentaire à `TRANSCRIPTION-ARCHITECTURE.md`. Elle précise **sous quelle
forme l'audio existe à chaque étape** et **ce qu'il est possible d'en extraire**, parce que
c'est le point sur lequel une proposition d'architecture peut se tromper sans que ça se voie.

---

## 1. Le point à ne pas rater : mediasoup ne décode jamais l'audio

mediasoup est un **SFU** (Selective Forwarding Unit). Son rôle est de recevoir des paquets
et de les réacheminer vers les bons destinataires. Il ne décode pas, ne mixe pas,
ne transcode pas et n'enregistre pas. C'est ce qui lui permet de tenir des dizaines de
participants sur un cœur : il ne touche jamais au contenu des paquets.

Conséquence directe : **aucune API de mediasoup ne rend du PCM.** Il n'existe pas de
« sortir le flux décodé en mémoire ». Tout ce qu'on peut obtenir, ce sont des **paquets RTP
contenant des trames Opus encodées**. Le décodage doit être fait par du code à nous, en aval.

Une proposition d'architecture qui suppose « mediasoup nous donne du PCM » n'est pas
réalisable telle quelle — mais l'intention derrière (supprimer les sockets UDP et ffmpeg)
l'est, par un autre mécanisme décrit au §4.

---

## 2. La chaîne de transformations, forme par forme

| Étape | Forme de l'audio | Qui la produit |
|---|---|---|
| Micro navigateur | PCM float32, fréquence du périphérique | `getUserMedia` |
| Encodage | **Opus 48 kHz**, trames de 20 ms (960 échantillons/canal) | encodeur du navigateur |
| Transport | **SRTP** (RTP chiffré) sur UDP/DTLS | WebRTC |
| Entrée SFU | **RTP** déchiffré, charge utile = 1 trame Opus | mediasoup |
| Sortie SFU | **RTP** ré-chiffré (vers navigateurs) ou en clair (vers nous) | mediasoup |
| Dépaquetage | trames **Opus** brutes | notre code |
| Décodage | **PCM 48 kHz** (s16 ou float32) | libopus / ffmpeg / PyAV |
| Rééchantillonnage | **PCM 16 kHz mono float32** | soxr / swresample |
| Modèle | tenseur d'échantillons | Whisper, Zipformer… |

Les modèles ASR courants — Whisper comme les Zipformer de sherpa-onnx — attendent tous du
**PCM mono 16 kHz en float32 normalisé entre -1 et 1**. Les étapes de décodage et de
rééchantillonnage sont donc incontournables, quel que soit le modèle choisi.

---

## 3. Les quatre façons de sortir de mediasoup

mediasoup expose quatre types de transports. Un seul est adapté au temps réel local.

**`WebRtcTransport`** — vers les navigateurs. Sort du SRTP. Inutilisable pour nous.

**`PlainTransport`** — RTP en clair sur UDP, vers un processus externe. C'est ce que
l'implémentation actuelle utilise. Il faut allouer un port de destination, écrire un fichier
SDP, lancer ffmpeg dessus, et appeler `transport.connect({ ip, port })` — sans quoi
mediasoup n'émet **rien**, silencieusement. C'est la source de la plupart des pannes
rencontrées : ports en conflit, interface d'écoute mal choisie, ffmpeg qui abandonne sur
timeout réseau.

**`PipeTransport`** — entre deux routers mediasoup, éventuellement sur des machines
différentes. Sert à la répartition de charge, pas à l'extraction.

**`DirectTransport`** — **le bon outil pour ce cas**. Les paquets sont livrés directement au
processus Node, sans réseau du tout :

```js
const transport = await router.createDirectTransport();
const consumer = await transport.consume({ producerId, rtpCapabilities });
consumer.on('rtp', (packet) => {
  // `packet` est un Buffer : un paquet RTP complet, en-tête compris.
});
```

Plus de port, plus de SDP, plus de `connect()`, plus de sous-processus, donc plus aucune des
pannes citées plus haut. En contrepartie, ce que l'on reçoit est **brut** : voir §5.

---

## 4. Ce que l'architecture proposée peut réellement être

L'idée « supprimer ffmpeg et les ports UDP, passer par un WebSocket local » est bonne. Voici
sa forme réalisable :

```
mediasoup (Node)
  └─ DirectTransport → consumer.on('rtp', buffer)
       │  paquets RTP contenant de l'Opus 48 kHz
       ▼
  WebSocket local (binaire)
       │
       ▼
Service Python (conteneur isolé par cpuset)
  ├─ dépaquetage RTP + reconstruction de la continuité temporelle
  ├─ décodage Opus → PCM 48 kHz          (PyAV, qui embarque libav sans lancer de processus)
  ├─ rééchantillonnage → PCM 16 kHz mono float32
  └─ sherpa-onnx OnlineRecognizer
```

Trois avantages concrets de faire le décodage **côté Python** plutôt que côté Node :

Le décodage se déroule à l'intérieur du conteneur limité par `cpuset`, donc il ne dispute
jamais ses cœurs à la visioconférence — ce qui est une contrainte forte du projet.

Node reste sans dépendance native compilée. Une liaison Opus en Node (`@discordjs/opus`,
`opusscript`) obligerait à compiler dans l'image du serveur média, avec les risques de
portabilité qui vont avec.

Enfin le service de transcription reste **autonome et redémarrable** indépendamment du
serveur média, ce qui est déjà le principe retenu aujourd'hui.

---

## 5. Ce que ffmpeg faisait pour nous, et qu'il faudra réimplémenter

C'est le point le plus important de cette note, et le plus facile à sous-estimer. En passant
au `DirectTransport`, on reçoit du RTP **brut**. ffmpeg s'occupait en silence de quatre
choses :

**Le désordre.** UDP ne garantit pas l'ordre d'arrivée. Il faut trier sur le numéro de
séquence RTP (16 bits, avec bouclage à gérer).

**Les pertes.** Un paquet perdu laisse un trou. Un modèle en flux qui reçoit deux trames non
consécutives collées bout à bout entend une discontinuité, ce qui dégrade la reconnaissance.
La bonne pratique est soit d'insérer du silence de la bonne durée, soit d'utiliser la
dissimulation de perte de paquets de libopus (`opus_decode` avec `NULL`), qui interpole.

**La continuité temporelle.** L'horodatage RTP d'Opus progresse de **960 par trame de 20 ms**
à 48 kHz. C'est lui, et non l'heure d'arrivée, qui dit combien d'audio s'est écoulé. Si
l'émetteur active la transmission discontinue (DTX), il cesse d'émettre pendant les silences
et l'horodatage fait un bond : sans reconstruire ce silence, le flux se comprime et
l'horodatage des phrases dérive.

**Le rééchantillonnage** de 48 kHz vers 16 kHz, avec un filtre correct. Un sous-échantillonnage
naïf par décimation introduit du repliement de spectre et dégrade la reconnaissance.

Cela représente environ une centaine de lignes en Python — PyAV gère le décodage, le
rééchantillonnage et la dissimulation de perte ; le tri et la reconstruction du temps restent
à écrire. Ce n'est pas un obstacle, mais il vaut mieux le budgéter que le découvrir.

---

## 6. Détails utiles pour dimensionner

- Payload type Opus : dynamique, négocié. **Ne jamais le coder en dur** — il se lit dans
  `consumer.rtpParameters.codecs[0].payloadType`. Une valeur figée à 111 fonctionne jusqu'au
  jour où mediasoup en choisit une autre, et les paquets sont alors ignorés en silence.
- mediasoup négocie `opus/48000/2`. Le contenu reste généralement mono ; il faut donc
  ramener à un canal après décodage.
- Débit d'un flux vocal Opus : environ **24 à 32 kbit/s**, soit ~150 paquets par seconde et
  par locuteur. Le volume transitant par le WebSocket local est donc négligeable.
- Après décodage et rééchantillonnage, un locuteur produit **32 Kio par seconde** de PCM
  16 kHz s16, ou 64 Kio en float32. Une heure d'audio tient dans 115 Mio.
- Le `consumer` doit être créé en pause puis repris, et il faut retenir l'identité du
  locuteur **au moment de la création** : le modèle rend son texte plus tard, quand le
  transport peut avoir été réattribué à quelqu'un d'autre.

---

## 7. Question ouverte, pour être complet

Le choix de faire transiter les trames **Opus** par le WebSocket, plutôt que du PCM déjà
décodé, est délibéré : il garde le décodage dans le conteneur isolé. L'alternative — décoder
côté Node et envoyer du PCM float32 — simplifie le service Python mais déplace le coût CPU
hors du `cpuset` et ajoute une dépendance native à l'image du serveur média.

Si un dimensionnement plus fin montrait que le décodage Opus est négligeable (ce qui est
probable : quelques pourcents d'un cœur pour dix flux), l'arbitrage pourrait s'inverser au
profit de la simplicité. C'est une décision à prendre sur mesure, pas par principe.
