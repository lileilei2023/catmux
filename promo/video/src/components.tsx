import React from 'react'
import { AbsoluteFill, Easing, Img, Interactive, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { C, FONT, SHOT_H, SHOT_W } from './theme'

export type Rect = { x: number; y: number; w: number; h: number }
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
export const ease = Easing.bezier(0.16, 1, 0.3, 1)

/** Dark backdrop with a soft accent glow and a faint grid. */
export const Backdrop: React.FC<{ glowY?: number }> = ({ glowY = 30 }) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.bg,
      backgroundImage: `radial-gradient(1200px 900px at 50% ${glowY}%, rgba(240,112,58,.16), transparent 60%), linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px)`,
      backgroundSize: '100% 100%, 54px 54px, 54px 54px',
    }}
  />
)

/** Headline + supporting line in the top safe area. */
export const Caption: React.FC<{ title: React.ReactNode; sub?: React.ReactNode; from?: number; top?: number }> = ({ title, sub, from = 0, top = 170 }) => {
  const frame = useCurrentFrame()
  return (
    <div style={{ position: 'absolute', left: 80, right: 80, top, fontFamily: FONT, color: C.fg, textAlign: 'center' }}>
      <Interactive.Div
        name="Headline"
        style={{
          fontSize: 88, fontWeight: 800, lineHeight: 1.18, letterSpacing: -1,
          opacity: interpolate(frame, [from, from + 12], [0, 1], { ...clamp, easing: ease }),
          translate: interpolate(frame, [from, from + 16], ['0px 40px', '0px 0px'], { ...clamp, easing: ease }),
        }}
      >
        {title}
      </Interactive.Div>
      {sub ? (
        <Interactive.Div
          name="Supporting"
          style={{
            marginTop: 28, fontSize: 46, fontWeight: 500, lineHeight: 1.45, color: C.muted,
            opacity: interpolate(frame, [from + 8, from + 22], [0, 1], { ...clamp, easing: ease }),
            translate: interpolate(frame, [from + 8, from + 24], ['0px 30px', '0px 0px'], { ...clamp, easing: ease }),
          }}
        >
          {sub}
        </Interactive.Div>
      ) : null}
    </div>
  )
}
export const Hl: React.FC<{ children: React.ReactNode }> = ({ children }) => <span style={{ color: C.accent }}>{children}</span>

/**
 * A rounded "window" showing a region of a screenshot. The visible region moves
 * from `from` to `to` (a camera move) between frames `t0` and `t1`.
 */
export const ShotCard: React.FC<{
  src: string; from: Rect; to?: Rect; t0?: number; t1?: number
  x?: number; y?: number; width?: number; height?: number; enter?: number
  children?: (map: (r: Rect) => React.CSSProperties) => React.ReactNode
}> = ({ src, from, to, t0 = 0, t1 = 60, x = 60, y = 640, width = 960, height, enter = 0, children }) => {
  const frame = useCurrentFrame()
  const end = to ?? from
  const k = (a: number, b: number) => interpolate(frame, [t0, t1], [a, b], { ...clamp, easing: Easing.bezier(0.45, 0, 0.2, 1) })
  const r = { x: k(from.x, end.x), y: k(from.y, end.y), w: k(from.w, end.w), h: k(from.h, end.h) }
  const h = height ?? Math.round(width * from.h / from.w)
  const scale = Math.max(width / r.w, h / r.h)
  const map = (q: Rect): React.CSSProperties => ({ position: 'absolute', left: (q.x - r.x) * scale, top: (q.y - r.y) * scale, width: q.w * scale, height: q.h * scale })
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, width, height: h, borderRadius: 28, overflow: 'hidden',
        border: `2px solid ${C.line}`, boxShadow: '0 40px 120px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04)',
        backgroundColor: '#0b0c0e',
        opacity: interpolate(frame, [enter, enter + 12], [0, 1], { ...clamp, easing: ease }),
        scale: interpolate(frame, [enter, enter + 18], [0.94, 1], { ...clamp, easing: ease }),
      }}
    >
      <Img
        src={staticFile(src)}
        style={{ position: 'absolute', left: -r.x * scale, top: -r.y * scale, width: SHOT_W * scale, height: SHOT_H * scale, maxWidth: 'none' }}
      />
      {children ? children(map) : null}
    </div>
  )
}

/** Pulsing accent outline around a region (inside a ShotCard). */
export const Focus: React.FC<{ style: React.CSSProperties; from: number; pad?: number }> = ({ style, from, pad = 10 }) => {
  const frame = useCurrentFrame()
  const pulse = 0.55 + 0.45 * Math.sin((frame - from) / 6)
  return (
    <div
      style={{
        ...style,
        left: (style.left as number) - pad, top: (style.top as number) - pad,
        width: (style.width as number) + pad * 2, height: (style.height as number) + pad * 2,
        borderRadius: 16, border: `5px solid ${C.accent}`,
        boxShadow: `0 0 ${30 + 30 * pulse}px rgba(240,112,58,${0.35 + 0.3 * pulse})`,
        opacity: interpolate(frame, [from, from + 10], [0, 1], { ...clamp, easing: ease }),
        scale: interpolate(frame, [from, from + 14], [1.15, 1], { ...clamp, easing: ease }),
      }}
    />
  )
}

/** Small brand mark at the bottom safe area. */
export const Watermark: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 110, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 18, fontFamily: FONT, color: C.muted, fontSize: 38, fontWeight: 600 }}>
    <Img src={staticFile('icon.png')} style={{ width: 64, height: 64 }} />
    Catmux · 开源免费
  </div>
)
