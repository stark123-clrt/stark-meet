'use client';

import { useState } from 'react';
import { Check, Info } from 'lucide-react';
import Switch from '@/components/ui/Switch';
import { TOGGLES } from '@/lib/preferences';

// Quelques fuseaux courants, plus celui du navigateur ajouté dynamiquement s'il
// n'y figure pas — inutile d'imposer une liste mondiale de 400 entrées.
const COMMON_ZONES = [
  'Europe/Paris', 'Europe/Brussels', 'Europe/London', 'Europe/Lisbon',
  'Africa/Abidjan', 'Africa/Kinshasa', 'Africa/Lagos', 'Africa/Casablanca',
  'America/Montreal', 'America/New_York', 'UTC',
];

function Card({ title, subtitle, children }) {
  return (
    <div className="bg-surface border border-slate-200 rounded-lg p-6">
      <h2 className="font-display font-bold text-[17px] tracking-heading">{title}</h2>
      {subtitle && <p className="mt-1 text-[13px] text-slate-700">{subtitle}</p>}
      <div className={subtitle ? 'mt-5' : 'mt-5'}>{children}</div>
    </div>
  );
}

function Field({ label, hint, ...props }) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-slate-700 mb-1.5">{label}</span>
      <input
        {...props}
        className="w-full h-11 px-3.5 rounded-sm border border-slate-200 bg-surface text-[15px] text-slate-950 placeholder:text-slate-500 outline-none transition-shadow duration-200 focus:border-brand-500 focus:shadow-focus disabled:bg-slate-50 disabled:text-slate-500"
      />
      {hint && (
        <span className="mt-1.5 flex items-start gap-1.5 text-[12px] text-slate-500">
          <Info className="mt-px h-3 w-3 flex-none" />
          {hint}
        </span>
      )}
    </label>
  );
}

export default function SettingsSection({ profile, preferences, onSave, saving, saved }) {
  const [name, setName] = useState(profile?.full_name || '');
  const [prefs, setPrefs] = useState(preferences);

  const zones = COMMON_ZONES.includes(prefs.timeZone)
    ? COMMON_ZONES
    : [prefs.timeZone, ...COMMON_ZONES];

  const dirty =
    name !== (profile?.full_name || '') ||
    JSON.stringify(prefs) !== JSON.stringify(preferences);

  const reset = () => {
    setName(profile?.full_name || '');
    setPrefs(preferences);
  };

  return (
    <div className="max-w-[640px] flex flex-col gap-5">
      <Card title="Profil">
        <div className="flex flex-col gap-4">
          <Field
            label="Nom complet"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Adam Joseph"
          />
          {/* L'adresse est celle du compte d'authentification : la changer
              suppose un e-mail de vérification, donc un service SMTP que
              l'instance n'a pas. Champ montré, mais désactivé et expliqué. */}
          <Field
            label="Adresse e-mail"
            type="email"
            value={profile?.email || ''}
            disabled
            readOnly
            hint="Liée à votre compte. Sa modification demande une vérification par e-mail, pas encore active."
          />
          <label className="block">
            <span className="block text-[13px] font-medium text-slate-700 mb-1.5">Fuseau horaire</span>
            <select
              value={prefs.timeZone}
              onChange={(e) => setPrefs((p) => ({ ...p, timeZone: e.target.value }))}
              className="w-full h-11 px-3 rounded-sm border border-slate-200 bg-surface text-[15px] outline-none transition-shadow duration-200 focus:border-brand-500 focus:shadow-focus"
            >
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </label>
        </div>
      </Card>

      <Card title="Réunions" subtitle="Ces réglages s'appliquent à chaque nouvel appel.">
        <div className="flex flex-col gap-[18px]">
          {TOGGLES.map(({ key, label, help }) => (
            <div key={key} className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-medium">{label}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-slate-700">{help}</p>
              </div>
              <Switch
                label={label}
                checked={prefs[key]}
                onChange={(value) => setPrefs((p) => ({ ...p, [key]: value }))}
              />
            </div>
          ))}
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <button
          onClick={() => onSave({ fullName: name.trim(), preferences: prefs })}
          disabled={!dirty || saving}
          className="h-11 px-6 rounded-sm bg-brand-500 text-surface text-[15px] font-semibold hover:bg-brand-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button
          onClick={reset}
          disabled={!dirty || saving}
          className="h-11 px-5 rounded-sm text-[15px] font-medium text-slate-700 hover:text-slate-950 hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Annuler
        </button>
        {saved && !dirty && (
          <span className="flex items-center gap-1.5 text-[13px] text-success-500">
            <Check className="h-4 w-4" /> Enregistré
          </span>
        )}
      </div>
    </div>
  );
}
