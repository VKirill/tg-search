import type React from 'react';
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

function StrokeIcon({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function IconInbox(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </StrokeIcon>
  );
}

export function IconLeads(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 14.8c1.6.6 2.6 2 3 4.2" />
    </StrokeIcon>
  );
}

export function IconFunnel(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <rect x="4" y="5" width="4" height="14" rx="1" />
      <rect x="10" y="5" width="4" height="10" rx="1" />
      <rect x="16" y="5" width="4" height="6" rx="1" />
    </StrokeIcon>
  );
}

export function IconTopics(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </StrokeIcon>
  );
}

export function IconBroadcast(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M4 10v4h3l6 4V6L7 10H4z" />
      <path d="M16.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </StrokeIcon>
  );
}

export function IconAccounts(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 18.2c1.2-2 3.1-3 5.5-3s4.3 1 5.5 3" />
    </StrokeIcon>
  );
}
