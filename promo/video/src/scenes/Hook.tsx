import React from 'react'
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, ease } from '../components'
import { C, FONT, MONO } from '../theme'

// Scattered terminal windows (one per machine) drifting in — the "before".
const WINDOWS = [
  { host: 'mac-mini', line: 'codex › 改分页…', x: 70, y: 980, r: -6 },
  { host: 'gpu-server', line: 'claude › epoch 14/40', x: 520, y: 1080, r: 5 },
  { host: '本机', line: 'tmux a -t web', x: 120, y: 1330, r: 4 },
  { host: 'cloud-dev', line: 'tail -f error.log', x: 560, y: 1420, r: -4 },
  { host: 'mac-mini', line: 'claude › 登录页…', x: 300, y: 1590, r: -2 },
]
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const Hook: React.FC = () => {
  const frame = useCurrentFrame()
  const lines = ['Mac mini 上跑 Codex', 'GPU 机上跑 Claude', '本机还有一堆 tmux']
  return (
    <AbsoluteFill>
      <Backdrop glowY={20} />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 190, fontFamily: FONT, color: C.fg }}>
        {lines.map((t, i) => (
          <Interactive.Div
            key={t}
            name={`Line ${i + 1}`}
            style={{
              fontSize: 64, fontWeight: 700, lineHeight: 1.5, color: C.muted,
              opacity: interpolate(frame, [i * 9, i * 9 + 10], [0, 1], { ...clamp, easing: ease }),
              translate: interpolate(frame, [i * 9, i * 9 + 14], ['-40px 0px', '0px 0px'], { ...clamp, easing: ease }),
            }}
          >
            {t}
          </Interactive.Div>
        ))}
        <Interactive.Div
          name="Punchline"
          style={{
            marginTop: 30, fontSize: 112, fontWeight: 900, letterSpacing: -2, color: C.fg,
            opacity: interpolate(frame, [34, 44], [0, 1], { ...clamp, easing: ease }),
            scale: interpolate(frame, [34, 48], [1.25, 1], { ...clamp, easing: Easing.spring({ damping: 12 }), output: 'perceptual-scale' }),
          }}
        >
          窗口切到<span style={{ color: C.accent }}>崩溃？</span>
        </Interactive.Div>
      </div>
      {WINDOWS.map((w, i) => (
        <div
          key={i}
          style={{
            position: 'absolute', left: w.x, top: w.y, width: 450, padding: '22px 26px', borderRadius: 20,
            background: C.panel, border: `2px solid ${C.line}`, boxShadow: '0 30px 80px rgba(0,0,0,.5)',
            fontFamily: MONO, fontSize: 30, color: C.fg,
            rotate: `${w.r + Math.sin((frame + i * 20) / 18) * 1.5}deg`,
            opacity: interpolate(frame, [6 + i * 5, 16 + i * 5], [0, 1], clamp),
            translate: interpolate(frame, [6 + i * 5, 26 + i * 5], ['0px 120px', '0px 0px'], { ...clamp, easing: ease }),
          }}
        >
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            {['#f0544c', '#e5b449', '#3fb37f'].map(c => <span key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />)}
            <span style={{ marginLeft: 12, fontSize: 24, color: C.dim }}>ssh {w.host}</span>
          </div>
          {w.line}<span style={{ opacity: frame % 20 < 10 ? 1 : 0, color: C.accent }}>▌</span>
        </div>
      ))}
    </AbsoluteFill>
  )
}
