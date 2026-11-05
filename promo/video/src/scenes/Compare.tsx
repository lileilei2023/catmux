import React from 'react'
import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, Caption, Hl, ease } from '../components'
import { C, FONT, MONO } from '../theme'

// What Catmux does not ask of the servers.
const ROWS = [
  ['不用换启动命令', '就是原生的 claude / codex'],
  ['不装 wrapper，没有中转', '只走你自己的 SSH'],
  ['没有超时', '断多久都能接回去'],
  ['已有的 tmux 会话', '一键导入'],
]
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const Compare: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backdrop glowY={50} />
      <Caption title={<>服务器上<Hl>什么都不用装</Hl></>} sub={<>只要 <span style={{ fontFamily: MONO, color: C.fg }}>tmux</span> + <span style={{ fontFamily: MONO, color: C.fg }}>python3</span></>} />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 640, display: 'flex', flexDirection: 'column', gap: 30, fontFamily: FONT }}>
        {ROWS.map(([a, b], i) => {
          const at = 18 + i * 14
          return (
            <Interactive.Div
              key={a}
              name={`Row ${i + 1}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 30, padding: '34px 40px', borderRadius: 28,
                background: 'rgba(63,179,127,.08)', border: '2px solid rgba(63,179,127,.32)',
                opacity: interpolate(frame, [at, at + 10], [0, 1], { ...clamp, easing: ease }),
                translate: interpolate(frame, [at, at + 16], ['0px 40px', '0px 0px'], { ...clamp, easing: ease }),
              }}
            >
              <span style={{ fontSize: 64, color: C.ok, fontWeight: 900, width: 64, textAlign: 'center' }}>✓</span>
              <div>
                <div style={{ fontSize: 54, fontWeight: 800, color: C.fg }}>{a}</div>
                <div style={{ fontSize: 40, color: C.muted, marginTop: 6 }}>{b}</div>
              </div>
            </Interactive.Div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}
