'use client';

import { Users, UserPlus } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';

/**
 * Contacts — déduits des participants de mes réunions passées.
 *
 * Pas de table dédiée : la liste se construit toute seule à partir de qui est
 * réellement venu, et elle est donc utile dès la première réunion au lieu de
 * démarrer vide et de demander une saisie manuelle.
 */
export default function ContactsSection({ contacts, onInvite }) {
  if (contacts.length === 0) {
    return (
      <div className="max-w-[1080px] bg-surface border border-slate-200 rounded-lg p-12 text-center">
        <Users className="h-9 w-9 text-slate-500 mx-auto mb-4" />
        <p className="text-[15px] font-medium text-slate-950">Aucun contact pour l&apos;instant</p>
        <p className="text-[13px] text-slate-700 mt-1.5">
          Les personnes qui rejoignent vos réunions apparaissent ici automatiquement.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-[1080px]">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {contacts.map((contact) => (
          <div
            key={contact.key}
            className="flex items-center gap-3.5 p-[18px] bg-surface border border-slate-200 rounded-lg transition-shadow duration-200 ease-standard hover:shadow-card-hover"
          >
            <Avatar size="lg" name={contact.name} seed={contact.key} />
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-medium truncate">{contact.name}</p>
              <p className="mt-0.5 text-[13px] text-slate-500 truncate">
                {contact.email || `Invité · ${contact.meetings} réunion${contact.meetings > 1 ? 's' : ''}`}
              </p>
            </div>
            <button
              onClick={() => onInvite(contact)}
              title="Créer une réunion et copier le lien à lui envoyer"
              className="h-8 px-3 flex-none flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Inviter
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
