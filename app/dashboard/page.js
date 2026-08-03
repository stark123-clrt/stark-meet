'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Plus, Copy, Video } from 'lucide-react';
import { createClient } from '@/lib/supabase';
import CreateMeetingDialog from '@/components/dashboard/CreateMeetingDialog';

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  useEffect(() => {
    checkUser();
  }, []);

  const checkUser = async () => {
    const supabase = createClient();
    const { data: { user: authUser } } = await supabase.auth.getUser();

    if (!authUser) {
      router.push('/auth');
      return;
    }

    setUser(authUser);

    const { data: profileData } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', authUser.id)
      .maybeSingle();
    setProfile(profileData);

    await loadMeetings(authUser.id);
    setLoading(false);
  };

  const loadMeetings = async (hostId) => {
    const supabase = createClient();
    const { data } = await supabase
      .from('meetings')
      .select('*')
      .eq('host_id', hostId)
      .order('created_at', { ascending: false });
    setMeetings(data || []);
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/auth');
  };

  const handleCreated = (meeting) => {
    setShowCreateDialog(false);
    setMeetings(prev => [meeting, ...prev]);
    if (meeting.status === 'active') {
      router.push(`/room/${meeting.meeting_code}`);
    }
  };

  const copyLink = (meetingCode) => {
    const url = `${window.location.origin}/room/${meetingCode}`;
    navigator.clipboard.writeText(url);
  };

  const statusLabel = {
    scheduled: { label: 'PLANIFIÉE', className: 'bg-ink-800 text-ink-500' },
    active: { label: 'EN DIRECT', className: 'bg-ok-500/15 text-ok-300' },
    completed: { label: 'TERMINÉE', className: 'bg-ink-800 text-ink-500' },
    cancelled: { label: 'ANNULÉE', className: 'bg-signal-500/15 text-signal-300' },
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <div className="text-mist-300 text-sm font-mono">Chargement…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950">
      <header className="flex items-center justify-between px-6 py-4 border-b border-ink-700">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-signal-500" />
          <span className="font-mono font-bold text-white text-sm tracking-tight">STARK MEET</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-mist-300">{profile?.full_name}</span>
          <button
            onClick={handleLogout}
            className="p-2 text-ink-500 hover:text-white hover:bg-ink-800 rounded-md transition-colors"
            title="Déconnexion"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-7">
          <div>
            <h1 className="font-mono text-xl text-white font-bold">Vos réunions</h1>
            <p className="text-ink-500 text-sm mt-1">
              {meetings.filter(m => m.status === 'scheduled').length} planifiée(s) ·{' '}
              {meetings.filter(m => m.status === 'active').length} en direct
            </p>
          </div>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-signal-500 hover:bg-signal-400 text-white rounded-md text-sm font-medium transition-colors"
          >
            <Plus className="h-4 w-4" />
            Nouvelle réunion
          </button>
        </div>

        {meetings.length === 0 ? (
          <div className="border border-ink-700 rounded-lg p-14 text-center">
            <Video className="h-10 w-10 text-ink-600 mx-auto mb-4" />
            <p className="text-mist-300 font-medium">Aucune réunion pour l'instant</p>
            <p className="text-ink-500 text-sm mt-1.5">Créez votre première réunion pour commencer.</p>
          </div>
        ) : (
          <div className="border border-ink-700 rounded-lg overflow-hidden">
            {meetings.map((meeting) => {
              const status = statusLabel[meeting.status] || statusLabel.scheduled;
              return (
                <div
                  key={meeting.id}
                  className="flex items-center gap-4 px-5 py-4 border-b border-ink-700 last:border-b-0"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{meeting.title}</p>
                    <p className="text-ink-500 text-xs font-mono mt-0.5">{meeting.meeting_code}</p>
                  </div>
                  <span className={`font-mono text-[10px] font-bold px-2 py-1 rounded ${status.className}`}>
                    {status.label}
                  </span>
                  <span className="text-mist-300 text-xs font-mono hidden sm:inline whitespace-nowrap">
                    {meeting.scheduled_at
                      ? new Date(meeting.scheduled_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
                      : 'Instantanée'}
                  </span>
                  {meeting.status !== 'completed' && meeting.status !== 'cancelled' ? (
                    <button
                      onClick={() => router.push(`/room/${meeting.meeting_code}`)}
                      className="px-3.5 py-1.5 bg-signal-500 hover:bg-signal-400 text-white text-xs font-medium rounded-md transition-colors whitespace-nowrap"
                    >
                      Rejoindre
                    </button>
                  ) : null}
                  <button
                    onClick={() => copyLink(meeting.meeting_code)}
                    className="p-2 text-ink-500 hover:text-white hover:bg-ink-800 rounded-md transition-colors"
                    title="Copier le lien"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {showCreateDialog && (
        <CreateMeetingDialog
          hostId={user.id}
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
