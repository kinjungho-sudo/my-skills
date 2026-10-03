---
name: shadergradient
description: ShaderGradient(@shadergradient/react, @shadergradient/vue)로 움직이는 3D 그라디언트 배경/비주얼을 React·Next.js·Vue·Nuxt 프로젝트에 넣거나 튜닝할 때 사용. "shader gradient", "셰이더 그라디언트", "움직이는 그라디언트 배경", "3D 그라디언트", "mesh gradient", "shadergradient.co/customize URL 적용", "히어로 배경 그라디언트" 같은 요청이나 코드에 ShaderGradient/ShaderGradientCanvas가 보이면 반드시 사용. 설치·호환 버전, props, 프리셋, SSR 처리, 성능·접근성까지 다룬다.
---

# ShaderGradient

three.js 위에서 도는 커스터마이즈 가능한 3D 움직이는 그라디언트 컴포넌트(ruucm/shadergradient, MIT).
React는 `@shadergradient/react`(R3F 기반, 문서 기준 v2.4.x), Vue/Nuxt는 `@shadergradient/vue`(TresJS 기반, v0.1.x).
Figma 플러그인·Framer 컴포넌트도 있다(코드 프로젝트가 아니면 README 링크 참고).

## 먼저 판단할 것

1. **프레임워크 확인**: React/Next → react 패키지, Vue/Nuxt → vue 패키지.
2. **React 환경에 맞는 버전 조합** (틀리면 App Router에서 깨진다):

| 환경 | React | @react-three/fiber | three |
|---|---|---|---|
| **Next 15 App Router** | `^19` | `^9` | `>=0.158` |
| Next 14 / Next 15 Pages / Vite 등 | `^18` 또는 `^19` | 8.x / 9.x (React 버전에 맞춤) | `>=0.158` |

   Next 15 App Router에서 R3F v8은 구조적으로 호환되지 않는다. `next.config` alias나 `transpilePackages`는 필요 없다.
3. 디자인을 직접 정하지 말고, 사용자가 [shadergradient.co/customize](https://www.shadergradient.co/customize)에서 만든 URL이 있으면 `control="query"` + `urlString`으로 그대로 적용하는 게 가장 정확하다.

## 설치

```bash
# React
npm i @shadergradient/react @react-three/fiber three three-stdlib camera-controls
npm i -D @types/three

# Vue / Nuxt (Vue 3.5+, TresJS 5, three 0.180+)
pnpm add @shadergradient/vue vue@^3.5 @tresjs/core@^5 three@^0.186.0
pnpm add -D @types/three@^0.186.0
```

## React 사용

```tsx
import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'

export default function Background() {
  return (
    <ShaderGradientCanvas
      style={{ position: 'absolute', inset: 0 }}
      pixelDensity={1.5}
      fov={45}
    >
      <ShaderGradient cDistance={32} cPolarAngle={125} />
    </ShaderGradientCanvas>
  )
}
```

URL 설정 적용:

```tsx
<ShaderGradientCanvas>
  <ShaderGradient
    control="query"
    urlString="https://www.shadergradient.co/customize?animate=on&cDistance=3.6&cPolarAngle=90&color1=%2352ff89&color2=%23dbba95&color3=%23d0bce1&lightType=3d&shader=defaults&type=plane&uFrequency=5.5&uSpeed=0.4&uStrength=4"
  />
</ShaderGradientCanvas>
```

- v2 패키지는 **렌더러만** 제공한다(`ShaderGradient`, `ShaderGradientCanvas`). 스토어/컨트롤 UI는 없고, 필요하면 자체 state를 쓰거나 `@shadergradient/ui`(npm 미배포, Framer/Figma용 ESM 번들)를 쓴다. 예전 `shadergradient-old`(v1, 스토어+UI 포함)는 기존 코드 유지용.
- 캔버스 부모/자체에 **0이 아닌 높이**가 있어야 보인다.

## Vue / Nuxt 사용

```vue
<script setup lang="ts">
import { ShaderGradient, ShaderGradientCanvas, presets } from '@shadergradient/vue'
</script>

<template>
  <ShaderGradientCanvas style="height: 400px" :pixel-density="1.5">
    <ShaderGradient v-bind="presets.mint.props" animate="off" />
    <template #fallback><div style="height:100%;background:#94ffd1" /></template>
  </ShaderGradientCanvas>
</template>
```

- Nuxt는 모듈·`ssr: false` 불필요. 캔버스가 SSR-safe라서 서버에서는 컨테이너와 `fallback` 슬롯만 그리고 마운트 후 캔버스를 만든다. 명시적 클라이언트 경계가 필요하면 `GradientBackground.client.vue`로 감싼다.
- 캔버스 관련 설정(`pixelDensity`, `fov`)은 `ShaderGradientCanvas`에, 나머지는 `ShaderGradient`에 둔다.
- 쿼리 URL의 알 수 없는 키·잘못된 enum·유한하지 않은 숫자는 무시되고, 빠진 값은 기본값이 쓰인다.

## 주요 props (`ShaderGradient`)

| 그룹 | props |
|---|---|
| 형태 | `type`(`plane`/`sphere`/`waterPlane`), `positionX/Y/Z`, `rotationX/Y/Z`(도 단위), `wireframe` |
| 재질·색 | `shader`(`defaults`/`positionMix`/`cosmic`/`glass`), `color1~3`, `reflection`, `uSpeed`, `uStrength`, `uDensity`, `uFrequency`, `uAmplitude`, `uTime` |
| 애니메이션 | `animate`(`on`/`off`), `range`(`enabled`/`disabled`), `rangeStart/End`, `loop`, `loopDuration` |
| 카메라 | `cAzimuthAngle`, `cPolarAngle`, `cDistance`, `cameraZoom`, `zoomOut`, `smoothTime`, `enableTransition`, `enableCameraUpdate`, `onCameraUpdate` |
| 조명 | `lightType`(`3d`/`env`), `brightness`, `envPreset`(`city`/`dawn`/`lobby`) |
| 효과 | `grain`(`on`/`off`), `grainBlending`, `toggleAxis` |
| 설정 | `control`(`props`/`query`), `urlString`, `hoverState` |

- `animate="off"`는 시간을 멈추고, `uTime`을 바꾸면 해당 시점으로 이동한다. 유효한 `loop`는 `range`보다 우선한다.
- 구(`sphere`)는 거리 14 고정 + `cameraZoom`, 평면은 `cDistance` + 줌 1로 동작한다.
- 전체 타입은 `references/types.ts`, README의 타입 블록은 `references/readme-react.md`.

`ShaderGradientCanvas` props: `pixelDensity`(기본 1, 1=빠름/2=정밀), `fov`(기본 45), `pointerEvents`(`none`/`auto`), `envBasePath`(자체 호스팅한 `city.hdr`/`dawn.hdr`/`lobby.hdr` 경로), `lazyLoad`(기본 true), `threshold`(0.1), `rootMargin`, `preserveDrawingBuffer`, `powerPreference`.
`pixelDensity`/`fov`를 바꾸면 캔버스가 새로 만들어진다.

## 프리셋

`references/presets.ts`에 `halo`, `pensive`, `mint`, `interstella`, `nightyNight`, `violaOrientalis`, `universe`, `sunset`, `mandarin`, `cottonCandy`가 있다.
Vue는 `presets.<name>.props`를 `v-bind`로 쓴다. React에서는 같은 값을 props로 풀어 쓰거나 customize URL을 사용한다.
프리셋 값 중 `frameRate`, `destination`, `format`, `embedMode`, `gizmoHelper`는 Figma/UI용 항목이라 렌더러 props가 아니다.

## 성능·접근성 체크리스트

- 화면 밖에서는 `lazyLoad`(기본 켜짐)로 씬이 언마운트되어 GPU가 해제된다. 돌아오면 새 씬이 만들어진다.
- 모바일/저사양은 `pixelDensity` 1 유지, 한 화면에 캔버스를 여러 개 두지 않기(하나의 `ShaderGradient`가 카메라·환경·포스트프로세싱을 소유하므로 독립 그라디언트는 캔버스를 나눈다).
- HDR 환경광(`lightType="env"`)은 원격 에셋을 받으므로 오프라인·CSP 환경이면 `envBasePath`로 자체 호스팅.
- 장식용 캔버스는 `aria-hidden`이 기본이며 포인터 이벤트도 무시한다. 의미 있는 이미지로 쓰면 `role="img"`와 라벨을 주고, `pointerEvents="auto"`로 카메라 제스처를 열 때는 키보드 대체 조작을 제공한다.
- 계속 움직이는 배경에는 일시정지 컨트롤을 두고, Vue 패키지는 `prefers-reduced-motion`이면 애니메이션·카메라 전환을 자동으로 끈다.

## 자주 나는 문제

- 아무것도 안 보임 → 캔버스 높이 0, 또는 `position: absolute` 부모에 크기 없음.
- Next App Router에서 에러 → React 19 + R3F v9 조합인지 확인(위 표).
- Nuxt/SSR 하이드레이션 문제 → 슬롯 안에서 직접 three 객체 접근 금지, `fallback` 슬롯 사용.
- 카메라 값이 안 먹음 → 구는 거리 고정이라 `cDistance` 대신 `cameraZoom` 사용.

## 참고 파일

| 파일 | 내용 |
|---|---|
| `references/readme-react.md` | 메인 README(설치, 호환 표, 사용법, 타입, 예제 링크) |
| `references/readme-vue.md` | Vue/Nuxt 설치·API·SSR·접근성 |
| `references/types.ts` | `MeshT`/`GradientT` 등 전체 타입 |
| `references/presets.ts` | 프리셋 10종의 전체 props 값 |
| `references/ShaderGradientCanvas.tsx` | 캔버스 props와 기본값 구현 |

출처: https://github.com/ruucm/shadergradient (MIT © ruucm, stone-skipper). 사본이므로 최신 API는 원본 확인.
