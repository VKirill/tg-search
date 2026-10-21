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

export function IconGroups(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h9A1.5 1.5 0 0 1 16 6.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3 2.5V14h-.5A1.5 1.5 0 0 1 4 12.5z" />
      <path d="M16 9h2.5A1.5 1.5 0 0 1 20 10.5v6a1.5 1.5 0 0 1-1.5 1.5H18v2l-2.5-2H12a1.5 1.5 0 0 1-1.5-1.5V16" />
      <path d="M7.5 9.5h5" />
    </StrokeIcon>
  );
}

export function IconChannel(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1z" />
      <path d="M16 9a4 4 0 0 1 0 6" />
      <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </StrokeIcon>
  );
}

export function IconNews(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <rect x="4" y="5" width="13" height="14" rx="1.5" />
      <path d="M17 9h2.5a.5.5 0 0 1 .5.5V17a2 2 0 0 1-2 2H6" />
      <path d="M7.5 9h6M7.5 12.5h6M7.5 16h3.5" />
    </StrokeIcon>
  );
}

export function IconStats(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M4 20h16" />
      <rect x="5.5" y="11" width="3" height="6" rx="0.8" />
      <rect x="10.5" y="6" width="3" height="11" rx="0.8" />
      <rect x="15.5" y="9" width="3" height="8" rx="0.8" />
    </StrokeIcon>
  );
}

export function IconChats(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M5 5.5h11a2 2 0 0 1 2 2V13a2 2 0 0 1-2 2H10l-4 3.5V15H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z" />
      <path d="M18 9h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v2.5L15 18" />
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

export function IconSubscriptions(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <rect x="5" y="6" width="14" height="12" rx="2" />
      <path d="M8 10h8M8 13.5h5" />
      <path d="M9 6V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V6" />
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

export function IconServices(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <rect x="4" y="5" width="7" height="7" rx="1.5" />
      <rect x="13" y="5" width="7" height="7" rx="1.5" />
      <rect x="4" y="14" width="7" height="6" rx="1.5" />
      <path d="M13 17h7M16.5 14v6" />
    </StrokeIcon>
  );
}

export function IconAgents(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 19c1.2-3 3.4-4.5 7-4.5s5.8 1.5 7 4.5" />
      <path d="M17 7.5l1.5-1.5M19 9.5h2" />
    </StrokeIcon>
  );
}

export function IconSkills(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M12 3l2.2 4.5 5 .7-3.6 3.4.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.2l5-.7L12 3z" />
    </StrokeIcon>
  );
}

export function IconApprovals(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M5 12l3 3 7-7" />
      <rect x="4" y="5" width="16" height="14" rx="2" />
    </StrokeIcon>
  );
}

export function IconSpam(p: IconProps) {
  return (
    <StrokeIcon {...p}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 4.5h3.4L20 12l-6.3 7.5h-3.4L4 12l6.3-7.5z" />
    </StrokeIcon>
  );
}
