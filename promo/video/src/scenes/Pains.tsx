import React from 'react'
import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, Caption, ease } from '../components'
import { C, FONT } from '../theme'

// The pain points that came up while building this, one at a time.
const PAINS = [
  ['刷新一下，画面狂闪', '输入框闪个不停'],
  ['AI 的输出复制不出来', '拖不动、选不中'],
  ['截图路径发过去', '远端根本没有这个文件'],
  ['agent 到底改了啥？', '只能在终端里翻'],
]
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const Pains: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backdrop glowY={40} />
      <Caption title="以前每天都在忍" />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 520, display: 'flex', flexDirection: 'column', gap: 36, fontFamily: FONT }}>
        {PAINS.map(([a, b], i) => {
          const at = 10 + i * 28
          return (
            <Interactive.Div
              key={a}
              name={`Pain ${i + 1}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 34, padding: '38px 44px', borderRadius: 28,
                background: 'rgba(240,84,76,.08)', border: '2px solid rgba(240,84,76,.28)',
                opacity: interpolate(frame, [at, at + 10], [0, 1], { ...clamp, easing: ease }),
                translate: interpolate(frame, [at, at + 16], ['80px 0px', '0px 0px'], { ...clamp, easing: ease }),
              }}
            >
              <span style={{ fontSize: 72, color: C.danger, fontWeight: 900, width: 72, textAlign: 'center' }}>✕</span>
              <div>
                <div style={{ fontSize: 56, fontWeight: 800, color: C.fg }}>{a}</div>
                <div style={{ fontSize: 44, color: C.muted, marginTop: 6 }}>{b}</div>
              </div>
            </Interactive.Div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}
