import { createClient } from '@supabase/supabase-js';

// Client serveur uniquement, clé service_role. Contourne les RLS et peut
// appeler l'API admin GoTrue (ex. confirmer un compte, exclure un
// participant côté auth). Ne jamais importer depuis un composant client.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
