// Samarth Analytics inline SVG logo.
// A simple sigil: a stylized "S" formed by ascending bars (signals climbing).
// Monochrome via currentColor with one accent dot.

interface BrandLogoProps {
  size?: number;
  className?: string;
  accent?: string;
  showWordmark?: boolean;
}

export function BrandLogo({
  size = 28,
  className = "",
  accent = "#FBBF24",
  showWordmark = true,
}: BrandLogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Samarth Analytics"
      >
        <rect width="32" height="32" rx="7" fill="currentColor" />
        <rect x="7"  y="18" width="3.2" height="7"   rx="0.8" fill="white" opacity="0.85" />
        <rect x="12" y="13" width="3.2" height="12"  rx="0.8" fill="white" opacity="0.95" />
        <rect x="17" y="9"  width="3.2" height="16"  rx="0.8" fill="white" />
        <circle cx="24" cy="9" r="2.4" fill={accent} />
      </svg>
      {showWordmark && (
        <div className="flex flex-col leading-tight">
          <span className="font-semibold tracking-tight text-[15px]">Samarth Analytics</span>
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground -mt-0.5">
            GTM Portal
          </span>
        </div>
      )}
    </div>
  );
}
