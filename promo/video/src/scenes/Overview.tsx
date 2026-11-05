import React from 'react'
import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, Caption, ShotCard, Hl } from '../components'
import { C, FONT } from '../theme'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const PANES = [
  { label: '设备 & 会话', x: 0, w: 272 },
  { label: '真实终端', x: 280, w: 670 },
  { label: '文件 & diff', x: 955, w: 485 },
]

export const Overview: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backdrop glowY={55} />
      <Caption title={<>三栏，<Hl>一屏看全</Hl></>} sub="像 Codex 桌面版一样顺手，管的是所有机器" />
      <ShotCard src="shots/hero.png" from={{ x: 0, y: 0, w: 1440, h: 900 }} y={700} width={960} enter={4}>
        {map => PANES.map((p, i) => (
          <div key={p.label} style={{ ...map({ x: p.x, y: 0, w: p.w, h: 900 }), borderRight: i < 2 ? `3px dashed ${C.accent}` : undefined, opacity: interpolate(frame, [24 + i * 8, 34 + i * 8], [0, 1], clamp) }} />
        ))}
      </ShotCard>
      <div style={{ position: 'absolute', left: 60, width: 960, top: 1430, display: 'flex', justifyContent: 'space-between', fontFamily: FONT }}>
        {PANES.map((p, i) => (
          <Interactive.Div
            key={p.label}
            name={`Label ${i + 1}`}
            style={{
              padding: '14px 26px', borderRadius: 999, background: 'rgba(255,255,255,.06)', border: `2px solid ${i === 1 ? C.accent : C.line}`, textAlign: 'center', fontSize: 42, fontWeight: 700, whiteSpace: 'nowrap',
              color: i === 1 ? C.accent : C.fg,
              opacity: interpolate(frame, [26 + i * 8, 36 + i * 8], [0, 1], clamp),
              translate: interpolate(frame, [26 + i * 8, 40 + i * 8], ['0px 30px', '0px 0px'], clamp),
            }}
          >
            {p.label}
          </Interactive.Div>
        ))}
      </div>
    </AbsoluteFill>
  )
}
