/**
 * A small hand-rolled icon set. Every glyph is a 16-unit stroke icon so the whole UI
 * shares one optical weight, and nothing is fetched from a CDN.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6L8 10.5 12.5 6" />
  </Svg>
);
export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 10L8 5.5 12.5 10" />
  </Svg>
);
export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 2.8l8 5.2-8 5.2z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPlayLine = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 2.8l8 5.2-8 5.2z" />
    <path d="M2 14.2h12" />
  </Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.07" />
    <path d="M13.8 1.7v3h-3" />
  </Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4" />
    <path d="M10.2 10.2L14 14" />
  </Svg>
);
export const IconDatabase = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="8" cy="3.8" rx="5" ry="2" />
    <path d="M3 3.8v8.4c0 1.1 2.2 2 5 2s5-.9 5-2V3.8" />
    <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </Svg>
);
export const IconTable = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.4" />
    <path d="M2.2 6.2h11.6M6.4 6.2v7" />
  </Svg>
);
export const IconChildTable = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 2.5v6.5a2 2 0 0 0 2 2h1.5" />
    <rect x="6.6" y="7.6" width="7.2" height="5.8" rx="1.2" />
    <path d="M6.6 10h7.2" />
  </Svg>
);
export const IconGraph = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.9l5.3 3.05v6.1L8 14.1 2.7 11.05v-6.1z" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 13.5h11" />
    <path d="M4.5 13.5V9M8 13.5V4M11.5 13.5V7" />
  </Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.3" />
    <path d="M10.4 5.6V4a1.4 1.4 0 0 0-1.4-1.4H4A1.4 1.4 0 0 0 2.6 4v5a1.4 1.4 0 0 0 1.4 1.4h1.6" />
  </Svg>
);
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2v7.4M5 7l3 3 3-3" />
    <path d="M2.6 12.6h10.8" />
  </Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.8M8 12.6v1.8M2.9 8H1.6M14.4 8h-1.3M4.4 4.4l-.9-.9M12.5 12.5l-.9-.9M11.6 4.4l.9-.9M3.5 12.5l.9-.9" />
  </Svg>
);
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
  </Svg>
);
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 9.9A5.6 5.6 0 0 1 6.1 3a5.6 5.6 0 1 0 6.9 6.9z" />
  </Svg>
);
export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.6l5.7 10.1H2.3z" />
    <path d="M8 6.2v3.1M8 11.2v.6" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.6l3.1 3.1L13 4.8" />
  </Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v4M8 4.9v.6" />
  </Svg>
);
export const IconSpinner = ({ size = 16, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" {...rest}>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.6" />
    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.7s" repeatCount="indefinite" />
    </path>
  </svg>
);
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.4" />
    <path d="M4.4 6.3l1.8 1.7-1.8 1.7M7.9 10.2h3.6" />
  </Svg>
);
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.2 1.8h3.6l-.5 4 2.4 2.1H4.3l2.4-2.1z" />
    <path d="M8 7.9v6.3" />
  </Svg>
);
export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.3 3.4h11.4L9.3 8.3v4.6l-2.6-1.5V8.3z" />
  </Svg>
);
export const IconSortAsc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.6 12.4V3.6M2.2 6l2.4-2.4L7 6" />
    <path d="M9.4 5.2h4.4M9.4 8.4h3.2M9.4 11.6h2" />
  </Svg>
);
export const IconSortDesc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.6 3.6v8.8M2.2 10l2.4 2.4L7 10" />
    <path d="M9.4 5.2h4.4M9.4 8.4h3.2M9.4 11.6h2" />
  </Svg>
);
export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 8a5.4 5.4 0 1 0 5.4-5.4A5.4 5.4 0 0 0 3.4 5" />
    <path d="M2.4 2.6v2.6h2.6" />
    <path d="M8 5.4V8l2 1.4" />
  </Svg>
);
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.6 9.4l2.8-2.8" />
    <path d="M7.4 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7l-1.1 1.1" />
    <path d="M8.6 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7l1.1-1.1" />
  </Svg>
);
export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 3.2a1.4 1.4 0 0 1 1.4-1.4H13v11.4H4a1.4 1.4 0 0 0-1.4 1.4z" />
    <path d="M2.6 3.2v10" />
  </Svg>
);
export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.3 6.2a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.6-1.8 2.7" />
    <path d="M8 11.4v.4" />
  </Svg>
);
export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.9l6 3-6 3-6-3z" />
    <path d="M2 8.4l6 3 6-3" />
    <path d="M2 11.6l6 3 6-3" />
  </Svg>
);
