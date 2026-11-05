import React from 'react'
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, ease } from '../components'
import { C, FONT, MONO } from '../theme'

// A Claude session on a server keeps running while the laptop is closed, then reattaches.
const OUT = [
  'claude › 重构支付模块',
  '  ✓ 读取 12 个文件',
  '  ✓ 修改 order/service.py',
  '  ✓ 测试 120/120 通过',
  '  ✓ 修改 api/refund.py',
  '  ✓ 完成，等你 review',
]
const CLOSE = 46
const OPEN = 84
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

export const Hook: React.FC = () => {
  const frame = useCurrentFrame()
  const lines = [
    { t: '合上笔记本', at: 0, color: C.fg },
    { t: 'Claude 还在服务器上跑', at: CLOSE + 4, color: C.fg },
    { t: '打开，回到刚才那一行', at: OPEN + 4, color: C.accent },
  ]
  const shown = frame < CLOSE ? 3 : frame < OPEN ? 3 : 6
  const off = interpolate(frame, [CLOSE, CLOSE + 8, OPEN, OPEN + 8], [0, 1, 1, 0], clamp)
  return (
    <AbsoluteFill>
      <Backdrop glowY={20} />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 180, fontFamily: FONT }}>
        {lines.map((l, i) => (
          <Interactive.Div
            key={l.t}
            name={`Line ${i + 1}`}
            style={{
              fontSize: i === 2 ? 84 : 76, fontWeight: 900, lineHeight: 1.35, letterSpacing: -1, color: l.color,
              opacity: interpolate(frame, [l.at, l.at + 10], [0, 1], { ...clamp, easing: ease }),
              translate: interpolate(frame, [l.at, l.at + 14], ['-40px 0px', '0px 0px'], { ...clamp, easing: ease }),
            }}
          >
            {l.t}
          </Interactive.Div>
        ))}
      </div>
      <div
        style={{
          position: 'absolute', left: 80, right: 80, top: 860, padding: '34px 40px', borderRadius: 28,
          background: C.panel, border: `2px solid ${C.line}`, boxShadow: '0 40px 120px rgba(0,0,0,.55)',
          fontFamily: MONO, fontSize: 40, lineHeight: 1.7, color: C.fg,
          opacity: interpolate(frame, [4, 14], [0, 1], clamp),
          translate: interpolate(frame, [4, 22], ['0px 100px', '0px 0px'], { ...clamp, easing: ease }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, fontFamily: FONT, fontSize: 32 }}>
          {['#f0544c', '#e5b449', '#3fb37f'].map(c => <span key={c} style={{ width: 18, height: 18, borderRadius: 9, background: c }} />)}
          <span style={{ marginLeft: 12, color: C.dim }}>gpu-server · tmux</span>
          <Badge frame={frame} />
        </div>
        <div style={{ filter: `grayscale(${off}) blur(${off * 3}px)`, opacity: 1 - off * 0.7 }}>
          {OUT.slice(0, shown).map((t, i) => (
            <div key={i} style={{ color: t.includes('✓') ? C.ok : t.startsWith('claude') ? C.fg : C.muted, opacity: i >= 3 ? interpolate(frame, [OPEN + 6 + (i - 3) * 6, OPEN + 12 + (i - 3) * 6], [0, 1], clamp) : 1 }}>{t}</div>
          ))}
          <span style={{ opacity: frame % 20 < 10 ? 1 : 0, color: C.accent }}>▌</span>
        </div>
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: FONT, fontSize: 58, fontWeight: 800, color: C.fg, opacity: off,
          }}
        >
          连接已断开 · 笔记本合盖
        </div>
      </div>
    </AbsoluteFill>
  )
}

const Badge: React.FC<{ frame: number }> = ({ frame }) => {
  const back = frame >= OPEN
  return (
    <span
      style={{
        marginLeft: 'auto', padding: '8px 22px', borderRadius: 999, fontWeight: 700,
        color: back ? C.ok : C.fg, background: back ? 'rgba(63,179,127,.16)' : 'rgba(255,255,255,.06)',
        border: `2px solid ${back ? 'rgba(63,179,127,.5)' : C.line}`,
        scale: back ? interpolate(frame, [OPEN, OPEN + 12], [1.3, 1], { ...clamp, easing: Easing.spring({ damping: 12 }), output: 'perceptual-scale' }) : 1,
      }}
    >
      {back ? '● 已重连 · 同一个会话' : frame >= CLOSE ? '○ 离线' : '● 运行中'}
    </span>
  )
}
