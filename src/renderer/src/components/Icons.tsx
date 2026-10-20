type IconProps = { size?: number; className?: string };

const stroke = 1.5;

export function IconSettings({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth={stroke} />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth={stroke} />
      <path d="M16 16l4 4" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}

export function IconThumbUp({ size = 16, className, filled }: IconProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} className={className} aria-hidden>
      <path
        d="M7 11v8a1 1 0 001 1h2.5l3.5-7.5V6a1 1 0 00-1-1H9.5a1 1 0 00-1 .7L7 8"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinejoin="round"
      />
      <rect x="3" y="11" width="3" height="9" rx="1" stroke="currentColor" strokeWidth={stroke} />
    </svg>
  );
}

export function IconThumbDown({ size = 16, className, filled }: IconProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} className={className} aria-hidden>
      <path
        d="M17 13V5a1 1 0 00-1-1h-2.5L10 11.5V18a1 1 0 001 1h3.5a1 1 0 001-.7L17 16"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinejoin="round"
      />
      <rect x="18" y="4" width="3" height="9" rx="1" stroke="currentColor" strokeWidth={stroke} />
    </svg>
  );
}

export function IconLightning({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M13 2L4 14h7l-1 8 10-14h-7l0-6z" />
    </svg>
  );
}

export function IconFilterLiked({ size = 16, className, active }: IconProps & { active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M7 11v8a1 1 0 001 1h2.5l3.5-7.5V6a1 1 0 00-1-1H9.5a1 1 0 00-1 .7L7 8"
        stroke="currentColor"
        strokeWidth={stroke}
        fill={active ? 'currentColor' : 'none'}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconFilterReplied({ size = 16, className, active }: IconProps & { active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M21 12a8 8 0 01-8 8H6l-4 3V12a8 8 0 018-8h5a8 8 0 018 8z"
        stroke="currentColor"
        strokeWidth={stroke}
        fill={active ? 'currentColor' : 'none'}
        opacity={active ? 0.35 : 1}
      />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}

export function IconFilterHidden({ size = 16, className, active }: IconProps & { active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z" stroke="currentColor" strokeWidth={stroke} />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth={stroke} fill={active ? 'currentColor' : 'none'} />
      {active && <path d="M4 4l16 16" stroke="currentColor" strokeWidth={stroke} />}
    </svg>
  );
}

export function IconSort({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M8 6h12M8 12h8M8 18h4" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
      <path d="M4 6v12M4 18l-2-2M4 18l2-2" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChevronDown({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}

export function IconClose({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}

export function IconExternal({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M14 4h6v6M10 14L20 4M18 10v8a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h8" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}
