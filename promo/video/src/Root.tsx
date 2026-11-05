import React from 'react'
import { Composition, Folder } from 'remotion'
import { Douyin, DOUYIN_FRAMES } from './Douyin'
import { ReadmeHero, README_FRAMES } from './ReadmeHero'
import { Hook } from './scenes/Hook'
import { Pains } from './scenes/Pains'
import { Reveal } from './scenes/Reveal'
import { Overview } from './scenes/Overview'
import { Devices } from './scenes/Devices'
import { Terminal } from './scenes/Terminal'
import { Diff } from './scenes/Diff'
import { PullRequest } from './scenes/PullRequest'
import { Create } from './scenes/Create'
import { Compare } from './scenes/Compare'
import { Cta } from './scenes/Cta'

const V = { width: 1080, height: 1920, fps: 30 }
export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="Douyin-Scenes">
      <Composition id="Hook" component={Hook} {...V} durationInFrames={135} />
      <Composition id="Pains" component={Pains} {...V} durationInFrames={150} />
      <Composition id="Reveal" component={Reveal} {...V} durationInFrames={90} />
      <Composition id="Overview" component={Overview} {...V} durationInFrames={120} />
      <Composition id="Devices" component={Devices} {...V} durationInFrames={120} />
      <Composition id="Terminal" component={Terminal} {...V} durationInFrames={165} />
      <Composition id="Diff" component={Diff} {...V} durationInFrames={135} />
      <Composition id="PullRequest" component={PullRequest} {...V} durationInFrames={135} />
      <Composition id="Create" component={Create} {...V} durationInFrames={120} />
      <Composition id="Compare" component={Compare} {...V} durationInFrames={120} />
      <Composition id="Cta" component={Cta} {...V} durationInFrames={150} />
    </Folder>
    <Composition id="Douyin" component={Douyin} {...V} durationInFrames={DOUYIN_FRAMES} />
    <Composition id="ReadmeHero" component={ReadmeHero} width={1280} height={800} fps={30} durationInFrames={README_FRAMES} />
  </>
)
