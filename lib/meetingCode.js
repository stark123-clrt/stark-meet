// Génère un code de réunion lisible et non-ambigu (pas de 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateMeetingCode() {
  const part = () =>
    Array.from({ length: 3 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  return `${part()}-${part()}`;
}
