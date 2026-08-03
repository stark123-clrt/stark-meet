import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabaseAdmin';

// Confirme automatiquement un compte à l'inscription : l'instance Supabase
// self-hosted n'a pas de SMTP configuré pour envoyer l'email de
// confirmation GoTrue, donc sans ça personne ne pourrait jamais se
// connecter après s'être inscrit.
export async function POST(request) {
  try {
    const { userId } = await request.json();
    if (!userId) {
      return NextResponse.json({ error: 'userId requis' }, { status: 400 });
    }

    const supabase = createAdminClient();
    const { error } = await supabase.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) throw error;

    return NextResponse.json({ message: 'Email confirmé' });
  } catch (error) {
    console.error('Error confirming email:', error);
    return NextResponse.json({ error: 'Une erreur est survenue' }, { status: 500 });
  }
}
