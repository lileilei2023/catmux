import React from 'react'
import { AbsoluteFill, Easing, Img, Interactive, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { Backdrop, ease } from '../components'
import { C, FONT, MONO } from '../theme'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const Cta: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backdrop glowY={35} />
      <AbsoluteFill style={{ alignItems: 'center', fontFamily: FONT }}>
      <Interactive.Div name="Icon" style={{ marginTop: 230, scale: interpolate(frame, [0, 18], [0.6, 1], { ...clamp, easing: Easing.spring({ damping: 12 }), output: 'perceptual-scale' }) }}>
        <Img src={staticFile('icon.png')} style={{ width: 300, height: 300 }} />
      </Interactive.Div>
      <Interactive.Div name="Title" style={{ fontSize: 120, fontWeight: 900, color: C.fg, letterSpacing: -2, marginTop: 10, opacity: interpolate(frame, [6, 16], [0, 1], clamp) }}>
        Catmux
      </Interactive.Div>
      <Interactive.Div name="Facts" style={{ fontSize: 50, fontWeight: 600, color: C.muted, marginTop: 14, opacity: interpolate(frame, [12, 22], [0, 1], clamp) }}>
        开源 · 免费 · macOS
      </Interactive.Div>
      <Interactive.Div
        name="Install"
        style={{
          marginTop: 90, width: 920, padding: '40px 44px', borderRadius: 28, background: '#16181c', border: `2px solid ${C.line}`,
          fontFamily: MONO, fontSize: 36, lineHeight: 1.55, color: C.fg, wordBreak: 'break-all',
          opacity: interpolate(frame, [22, 34], [0, 1], { ...clamp, easing: ease }),
          translate: interpolate(frame, [22, 38], ['0px 40px', '0px 0px'], { ...clamp, easing: ease }),
        }}
      >
        <div style={{ fontFamily: FONT, fontSize: 40, fontWeight: 700, color: C.accent, marginBottom: 18 }}>一行命令安装</div>
        <span style={{ color: C.dim }}>$ </span>curl -fsSL https://raw.githubusercontent.com/lileilei2023/catmux/main/install.sh | bash
      </Interactive.Div>
      <Interactive.Div
        name="Search"
        style={{
          marginTop: 80, fontSize: 64, fontWeight: 900, color: C.fg,
          opacity: interpolate(frame, [40, 52], [0, 1], { ...clamp, easing: ease }),
          scale: interpolate(frame, [40, 56], [1.15, 1], { ...clamp, easing: Easing.spring({ damping: 12 }), output: 'perceptual-scale' }),
        }}
      >
        GitHub 搜 <span style={{ color: C.accent }}>catmux</span>
      </Interactive.Div>
      <Interactive.Div name="Repo" style={{ marginTop: 18, fontFamily: MONO, fontSize: 40, color: C.muted, opacity: interpolate(frame, [48, 58], [0, 1], clamp) }}>
        github.com/lileilei2023/catmux
      </Interactive.Div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
