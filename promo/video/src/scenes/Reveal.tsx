import React from 'react'
import { AbsoluteFill, Easing, Img, Interactive, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { Backdrop, ease } from '../components'
import { C, FONT } from '../theme'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const Reveal: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backdrop glowY={45} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Interactive.Div
        name="Icon"
        style={{
          scale: interpolate(frame, [0, 22], [0.3, 1], { ...clamp, easing: Easing.spring({ damping: 11 }), output: 'perceptual-scale' }),
          rotate: interpolate(frame, [0, 22], ['-14deg', '0deg'], { ...clamp, easing: ease }),
          marginTop: -180,
        }}
      >
        <Img src={staticFile('icon.png')} style={{ width: 460, height: 460 }} />
      </Interactive.Div>
      <Interactive.Div
        name="Name"
        style={{
          fontFamily: FONT, fontSize: 150, fontWeight: 900, color: C.fg, letterSpacing: -3, marginTop: 10,
          opacity: interpolate(frame, [12, 24], [0, 1], { ...clamp, easing: ease }),
          translate: interpolate(frame, [12, 28], ['0px 40px', '0px 0px'], { ...clamp, easing: ease }),
        }}
      >
        Catmux
      </Interactive.Div>
      <Interactive.Div
        name="Tagline"
        style={{
          fontFamily: FONT, fontSize: 52, fontWeight: 600, color: C.muted, marginTop: 24, textAlign: 'center', lineHeight: 1.5,
          opacity: interpolate(frame, [24, 36], [0, 1], { ...clamp, easing: ease }),
        }}
      >
        一个窗口，管住<span style={{ color: C.accent }}>所有机器</span>上的 AI 会话
      </Interactive.Div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
