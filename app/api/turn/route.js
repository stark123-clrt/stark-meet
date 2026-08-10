import { NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * Identifiants TURN temporaires.
 *
 * coturn est configuré en `use-auth-secret` : il n'a pas de comptes en base,
 * il valide un couple nom/mot de passe dérivé d'un secret partagé. Le nom
 * porte la date d'expiration, le mot de passe en est la signature HMAC-SHA1.
 *
 * Pourquoi pas un mot de passe fixe : le navigateur voit forcément ces
 * identifiants, ils sont donc publics par nature. Fixes, n'importe qui lisant
 * le JavaScript disposerait d'un relais de bande passante gratuit et
 * permanent. Signés et datés, ils ne valent plus rien après expiration.
 *
 * Le secret ne quitte jamais le serveur : seule la signature part au client.
 */

const TTL_SECONDS = 4 * 60 * 60; // large devant la durée d'une réunion

export async function GET() {
  const secret = process.env.TURN_SECRET;
  const host = process.env.TURN_HOST;

  // Sans configuration TURN, on renvoie une liste vide plutôt qu'une erreur :
  // l'application doit continuer de fonctionner en connexion directe, c'est le
  // cas de la très grande majorité des utilisateurs.
  if (!secret || !host) {
    return NextResponse.json(
      { iceServers: [], configured: false },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const username = `${expiry}:stark-meet`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');

  return NextResponse.json(
    {
      configured: true,
      ttl: TTL_SECONDS,
      iceServers: [
        { urls: `stun:${host}:3478` },
        {
          // Les deux transports : l'UDP est préféré, le TCP sert de repli sur
          // les réseaux qui le bloquent — c'est la moitié de l'intérêt du TURN.
          urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`],
          username,
          credential,
        },
      ],
    },
    // Jamais de cache : un identifiant mis en cache survivrait à son expiration.
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
