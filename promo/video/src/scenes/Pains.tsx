import React from 'react'
import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, Caption, ease } from '../components'
import { C, FONT } from '../theme'

// The three things that hurt when Claude runs on servers instead of the laptop.
const PAINS = [
  ['远程用 Claude 不像本机', '截图、复制、看改动都别扭'],
  ['好几台服务器，十几个会话', 'ssh 窗口切到崩溃'],
  ['一断线就慌', '合盖、换 Wi-Fi，任务还在不在？'],
]
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const Pains: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backdrop glowY={40} />
      <Caption title="以前每天都在忍" />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 520, display: 'flex', flexDirection: 'column', gap: 40, fontFamily: FONT }}>
        {PAINS.map(([a, b], i) => {
          const at = 10 + i * 26
          return (
            <Interactive.Div
              key={a}
              name={`Pain ${i + 1}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 34, padding: '44px 44px', borderRadius: 28,
                background: 'rgba(240,84,76,.08)', border: '2px solid rgba(240,84,76,.28)',
                opacity: interpolate(frame, [at, at + 10], [0, 1], { ...clamp, easing: ease }),
                translate: interpolate(frame, [at, at + 16], ['80px 0px', '0px 0px'], { ...clamp, easing: ease }),
              }}
            >
              <span style={{ fontSize: 72, color: C.danger, fontWeight: 900, width: 72, textAlign: 'center' }}>✕</span>
              <div>
                <div style={{ fontSize: 58, fontWeight: 800, color: C.fg }}>{a}</div>
                <div style={{ fontSize: 42, color: C.muted, marginTop: 8 }}>{b}</div>
              </div>
            </Interactive.Div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}
