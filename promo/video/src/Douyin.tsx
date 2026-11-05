import React from 'react'
import { useCurrentFrame } from 'remotion'
import { linearTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { slide } from '@remotion/transitions/slide'
import { Hook } from './scenes/Hook'
import { Pains } from './scenes/Pains'
import { Reveal } from './scenes/Reveal'
import { Overview } from './scenes/Overview'
import { Devices } from './scenes/Devices'
import { Terminal } from './scenes/Terminal'
import { Diff } from './scenes/Diff'
import { PullRequest } from './scenes/PullRequest'
import { Create } from './scenes/Create'
import { Cta } from './scenes/Cta'
import { Watermark } from './components'

// 9:16 short for Douyin. Scene durations are inline so Studio can edit them.
export const DOUYIN_FRAMES = 90 + 150 + 90 + 120 + 120 + 165 + 135 + 135 + 120 + 150 - 9 * 10
// TransitionSeries only accepts its own elements as direct children: return them, don't wrap them.
const T = () => <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 10 })} />
const S = () => <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={linearTiming({ durationInFrames: 10 })} />

export const Douyin: React.FC = () => (
  <>
    <TransitionSeries>
      <TransitionSeries.Sequence name="Hook" durationInFrames={90}><Hook /></TransitionSeries.Sequence>
      {T()}
      <TransitionSeries.Sequence name="Pains" durationInFrames={150}><Pains /></TransitionSeries.Sequence>
      {T()}
      <TransitionSeries.Sequence name="Reveal" durationInFrames={90}><Reveal /></TransitionSeries.Sequence>
      {T()}
      <TransitionSeries.Sequence name="Overview" durationInFrames={120}><Overview /></TransitionSeries.Sequence>
      {S()}
      <TransitionSeries.Sequence name="Devices" durationInFrames={120}><Devices /></TransitionSeries.Sequence>
      {S()}
      <TransitionSeries.Sequence name="Terminal" durationInFrames={165}><Terminal /></TransitionSeries.Sequence>
      {S()}
      <TransitionSeries.Sequence name="Diff" durationInFrames={135}><Diff /></TransitionSeries.Sequence>
      {S()}
      <TransitionSeries.Sequence name="PullRequest" durationInFrames={135}><PullRequest /></TransitionSeries.Sequence>
      {S()}
      <TransitionSeries.Sequence name="Create" durationInFrames={120}><Create /></TransitionSeries.Sequence>
      {T()}
      <TransitionSeries.Sequence name="Cta" durationInFrames={150}><Cta /></TransitionSeries.Sequence>
    </TransitionSeries>
    <WatermarkUntilCta />
  </>
)
// Brand mark on feature scenes (not on the hook or the final call to action).
const WatermarkUntilCta: React.FC = () => {
  const frame = useCurrentFrame()
  return frame > 320 && frame < DOUYIN_FRAMES - 150 ? <Watermark /> : null
}
