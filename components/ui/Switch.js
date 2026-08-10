'use client';

/**
 * Interrupteur, calé sur le gabarit 44×24 du système de design.
 *
 * Un vrai <input type="checkbox"> sous l'habillage : le composant reste
 * atteignable au clavier et annoncé correctement par les lecteurs d'écran, ce
 * qu'un <div> cliquable ne fait pas.
 */
export default function Switch({ checked, onChange, label, disabled = false }) {
  return (
    <label
      className={`relative inline-flex flex-none items-center ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        aria-label={label}
        className="peer sr-only"
      />
      <span className="w-11 h-6 rounded-full bg-slate-200 transition-colors duration-200 ease-standard peer-checked:bg-brand-500 peer-focus-visible:shadow-focus" />
      <span className="absolute left-0.5 w-5 h-5 rounded-full bg-surface shadow-sm transition-transform duration-200 ease-standard peer-checked:translate-x-5" />
    </label>
  );
}
